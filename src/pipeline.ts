// One chat turn: route -> gather approved facts -> ground the model -> answer.
// This is the whole answer path in one place. It never throws; failures become
// a graceful hand-off.

import { config } from "./config.js";
import {
  allPricesBlock,
  allServicesBlock,
  factsFor,
} from "./facts.js";
import { faqs } from "./knowledge.js";
import { complete, stream, type ChatMessage } from "./llm.js";
import { buildUserTurn, HANDOFF_TEXT, SYSTEM_PROMPT } from "./prompt.js";
import { route } from "./intent.js";
import { search } from "./retrieval.js";
import type { Citation, ChatResponse, Intent } from "./types.js";

interface Grounding {
  intent: Intent;
  factsBlock: string;
  citations: Citation[];
  retrievalScores: { id: string; score: number }[];
}

// Decide the intent and assemble the approved-fact context for the message.
function ground(message: string): Grounding {
  const { intent, serviceIds } = route(message);
  const hits = search(message, 4);
  const retrievalScores = hits.map((h) => ({ id: h.id, score: Number(h.score.toFixed(3)) }));

  let factsBlock = "";
  const citations: Citation[] = [];

  // Pull in relevant FAQ answers as approved facts — only confident matches, so
  // the model isn't grounded on marginally-related Q&A.
  const FAQ_MIN_SCORE = 2.5;
  const faqIds = new Set(
    hits
      .filter((h) => h.kind === "faq" && h.score >= FAQ_MIN_SCORE)
      .slice(0, 2)
      .map((h) => h.id),
  );
  const faqLines: string[] = [];
  for (const f of faqs) {
    if (faqIds.has(f.id)) {
      faqLines.push(`FAQ Q: ${f.question} A: ${f.answer}`);
      citations.push({ kind: "faq", id: f.id, label: f.question });
    }
  }

  if (intent === "price_query") {
    const svc = serviceIds.length ? factsFor(serviceIds) : allPricesBlock();
    factsBlock = svc.block;
    citations.push(...svc.citations);
  } else if (intent === "service_query") {
    const svc = serviceIds.length ? factsFor(serviceIds) : allServicesBlock();
    factsBlock = svc.block;
    citations.push(...svc.citations);
  } else if (intent === "training_availability_query") {
    // Availability is dynamic operational data and is NOT in this PoC. Ground
    // the model to say so honestly rather than invent dates.
    factsBlock =
      "AVAILABILITY: Live course availability is not connected in this preview. Do not state specific dates or spaces. Invite the visitor to enquire and offer a callback.";
    if (serviceIds.length) {
      const svc = factsFor(serviceIds);
      factsBlock += `\n${svc.block}`;
      citations.push(...svc.citations);
    }
  } else if (intent === "lead_or_callback_request") {
    factsBlock =
      "LEAD: The visitor wants to be contacted. Confirm warmly that the office can call back, and invite a name and a phone or email. Do not ask for sensitive details.";
  }

  // Always append any relevant FAQ facts.
  if (faqLines.length) {
    factsBlock = [factsBlock, ...faqLines].filter(Boolean).join("\n");
  }

  return { intent, factsBlock, citations: dedupe(citations), retrievalScores };
}

function dedupe(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  return citations.filter((c) => {
    const key = `${c.kind}:${c.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function messagesFor(message: string, factsBlock: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserTurn(message, factsBlock) },
  ];
}

// Non-streaming turn -> full ChatResponse.
export async function answer(message: string): Promise<ChatResponse> {
  const started = Date.now();
  const g = ground(message);
  const result = await complete(messagesFor(message, g.factsBlock));

  const handoff = !result.ok;
  return {
    answer: handoff ? HANDOFF_TEXT : result.text,
    intent: g.intent,
    handoff,
    citations: g.citations,
    meta: {
      mode: config.llm.mode,
      model: config.llm.mode === "live" ? config.llm.model : undefined,
      latencyMs: Date.now() - started,
      retrievalScores: g.retrievalScores,
    },
  };
}

// Streaming turn. Yields text deltas; returns the citations/intent via the
// onMeta callback before the first token.
export async function* answerStream(
  message: string,
  onMeta: (meta: { intent: Intent; citations: Citation[] }) => void,
): AsyncGenerator<string, void, unknown> {
  const g = ground(message);
  onMeta({ intent: g.intent, citations: g.citations });
  try {
    let any = false;
    for await (const delta of stream(messagesFor(message, g.factsBlock))) {
      any = true;
      yield delta;
    }
    if (!any) yield HANDOFF_TEXT;
  } catch (err) {
    console.error(`[pipeline] stream failed: ${err instanceof Error ? err.name : err}`);
    yield HANDOFF_TEXT;
  }
}
