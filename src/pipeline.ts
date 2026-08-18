// One chat turn: route -> gather approved facts -> ground the model -> answer.
// This is the whole answer path in one place. It never throws; failures become
// a graceful hand-off.

import { config } from "./config.js";
import {
  allPricesBlock,
  allServicesBlock,
  factsFor,
  serviceFactsOnly,
} from "./facts.js";
import { faqs } from "./knowledge.js";
import { complete, stream, type ChatMessage } from "./llm.js";
import {
  buildUserTurn,
  CALLBACK_DECLINE_TEXT,
  CAR_LESSONS_OUT_OF_SCOPE_TEXT,
  CLARIFY_TEXT,
  GREETING_TEXT,
  HANDOFF_TEXT,
  INSTRUCTOR_SELECTION_TEXT,
  IRRELEVANT_TEXT,
  PERSONAL_INFO_TEXT,
  SYSTEM_PROMPT,
  UNSURE_TEXT,
} from "./prompt.js";
import {
  containsPersonalInfo,
  isBroadOfferingQuery,
  isCallbackRequest,
  isGreeting,
  isInstructorSelectionRequest,
  isOrdinaryCarLessonQuery,
  isShortAffirmative,
  route,
} from "./intent.js";
import { search } from "./retrieval.js";
import {
  clearPendingPricingOffer,
  getPendingPricingOffer,
  setPendingPricingOffer,
} from "./session.js";
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

  // Deterministic scope boundary: never let retrieval noise dress this up as
  // a B+E ("car and trailer") answer.
  if (isOrdinaryCarLessonQuery(message)) {
    return {
      intent,
      factsBlock: `SCOPE ${CAR_LESSONS_OUT_OF_SCOPE_TEXT}`,
      citations: [],
      retrievalScores: [],
    };
  }

  // A plain "hi"/"hello" gets the same fixed introduction the widget shows on
  // load, rather than a generic "I don't have that to hand" reply.
  if (isGreeting(message)) {
    return {
      intent,
      factsBlock: `SCOPE ${GREETING_TEXT}`,
      citations: [],
      retrievalScores: [],
    };
  }

  // A broad "what do you offer" question gets the FULL course list, not
  // whatever a single service/FAQ retrieval happened to rank first — see
  // isBroadOfferingQuery's comment for why that was previously misfiring.
  if (isBroadOfferingQuery(message)) {
    const svc = allServicesBlock();
    return {
      intent: "service_query",
      factsBlock: `BROAD_OFFER_LIST\n${svc.block}`,
      citations: svc.citations,
      retrievalScores: [],
    };
  }

  const hits = search(message, 4);
  const retrievalScores = hits.map((h) => ({ id: h.id, score: Number(h.score.toFixed(3)) }));

  let factsBlock = "";
  const citations: Citation[] = [];

  // Pull in relevant FAQ answers as approved facts — only confident matches, so
  // the model isn't grounded on marginally-related Q&A. Walk `hits` (already
  // ranked by score) rather than `faqs` (spreadsheet ID order) — the mock
  // renderer and a live model both tend to lead with whichever FAQ line comes
  // first, so the best match has to be first, not just present.
  const FAQ_MIN_SCORE = 2.5;
  const faqById = new Map(faqs.map((f) => [f.id, f]));
  const faqLines: string[] = [];
  for (const h of hits.filter((h) => h.kind === "faq" && h.score >= FAQ_MIN_SCORE).slice(0, 2)) {
    const f = faqById.get(h.id);
    if (!f) continue;
    faqLines.push(`FAQ Q: ${f.question} A: ${f.answer}`);
    citations.push({ kind: "faq", id: f.id, label: f.question });
  }

  if (intent === "price_query") {
    const svc = serviceIds.length ? factsFor(serviceIds) : allPricesBlock();
    factsBlock = svc.block;
    citations.push(...svc.citations);
  } else if (intent === "service_query") {
    // No price here by design (information pacing) — a "what is X" question
    // didn't ask what it costs, so don't drag pricing in unprompted.
    const svc = serviceIds.length ? serviceFactsOnly(serviceIds) : allServicesBlock();
    factsBlock = svc.block;
    citations.push(...svc.citations);
  } else if (intent === "training_availability_query") {
    // Availability is dynamic operational data and is NOT in this PoC. Ground
    // the model to say so honestly rather than invent dates. Point to the
    // website/team, not a callback — the chat doesn't take contact details
    // (see CALLBACK_DECLINE_TEXT) even to arrange one.
    factsBlock =
      "AVAILABILITY: Live course availability is not connected in this preview. Do not state specific dates or spaces. Invite the visitor to enquire via the NEDS website or get in touch with the team directly.";
    if (serviceIds.length) {
      const svc = serviceFactsOnly(serviceIds);
      factsBlock += `\n${svc.block}`;
      citations.push(...svc.citations);
    }
  }

  // Always append any relevant FAQ facts.
  if (faqLines.length) {
    factsBlock = [factsBlock, ...faqLines].filter(Boolean).join("\n");
  }

  return { intent, factsBlock, citations: dedupe(citations), retrievalScores };
}

// A narrow service_query that withheld price (see facts.ts's
// serviceFactsOnly) is exactly the case where the mock/live answer offers to
// "run through pricing too" — remember that as a pending offer so a short
// "yes please" next turn can be resolved directly. Anything else (a new
// question, the broad course-list view, a price already given) clears it, so
// a stale "yes" from several turns back can't misfire.
function updatePendingPricingOffer(sessionId: string | undefined, g: Grounding): void {
  const withheldPrice =
    g.intent === "service_query" &&
    !g.factsBlock.startsWith("BROAD_OFFER_LIST") &&
    !g.citations.some((c) => c.kind === "price");
  const serviceIds = g.citations.filter((c) => c.kind === "service").map((c) => c.id);
  if (withheldPrice && serviceIds.length > 0) {
    setPendingPricingOffer(sessionId, serviceIds);
  } else {
    clearPendingPricingOffer(sessionId);
  }
}

// Fixed policy replies that are decided before grounding and never reach the
// model — each is a hard refusal/decline where the exact wording matters
// (privacy, safety, fairness policy) more than letting the model paraphrase.
// Checked in order; the first match wins.
const DETERMINISTIC_REPLIES: { test: (message: string) => boolean; intent: Intent; text: string }[] = [
  { test: containsPersonalInfo, intent: "out_of_scope", text: PERSONAL_INFO_TEXT },
  { test: isCallbackRequest, intent: "lead_or_callback_request", text: CALLBACK_DECLINE_TEXT },
  { test: isInstructorSelectionRequest, intent: "out_of_scope", text: INSTRUCTOR_SELECTION_TEXT },
];

function deterministicReply(message: string): { intent: Intent; text: string } | undefined {
  return DETERMINISTIC_REPLIES.find((r) => r.test(message));
}

// When there are no facts to ground on: if the message shares no vocabulary
// at all with the approved knowledge (no BM25 hit whatsoever, across FAQs and
// services), it isn't recognisably about NEDS — say so plainly. Otherwise it
// looked on-topic but nothing was confident enough to answer from — say we're
// unsure rather than guessing.
function noFactsFallback(g: Grounding): string {
  return g.retrievalScores.length > 0 ? UNSURE_TEXT : IRRELEVANT_TEXT;
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

// A short "yes"-shaped reply only means something in light of a pending
// pricing offer (see updatePendingPricingOffer). Resolves it into the facts
// for THAT service (price included this time) — or, if there's nothing
// pending for this session, signals that the pipeline should ask for
// clarification rather than let the bare word "yes" fall through to
// retrieval and possibly match some unrelated FAQ.
function resolveAffirmative(
  message: string,
  sessionId: string | undefined,
): { factsBlock: string; citations: Citation[] } | "clarify" | undefined {
  if (!isShortAffirmative(message)) return undefined;
  const pendingServiceIds = getPendingPricingOffer(sessionId);
  if (!pendingServiceIds) return "clarify";
  clearPendingPricingOffer(sessionId);
  const svc = factsFor(pendingServiceIds);
  return { factsBlock: `CONFIRMED_OFFER\n${svc.block}`, citations: svc.citations };
}

// Non-streaming turn -> full ChatResponse.
export async function answer(message: string, sessionId?: string): Promise<ChatResponse> {
  const started = Date.now();

  // Fixed policy declines (personal info, callback requests, instructor
  // selection) are decided and returned before grounding even starts, so the
  // message never reaches the model in these cases.
  const bypass = deterministicReply(message);
  if (bypass) {
    clearPendingPricingOffer(sessionId);
    return {
      answer: bypass.text,
      intent: bypass.intent,
      handoff: true,
      citations: [],
      meta: {
        mode: config.llm.mode,
        model: config.llm.mode === "live" ? config.llm.model : undefined,
        latencyMs: Date.now() - started,
        retrievalScores: [],
      },
    };
  }

  const affirmative = resolveAffirmative(message, sessionId);
  if (affirmative === "clarify") {
    return {
      answer: CLARIFY_TEXT,
      intent: "out_of_scope",
      handoff: false,
      citations: [],
      meta: {
        mode: config.llm.mode,
        model: config.llm.mode === "live" ? config.llm.model : undefined,
        latencyMs: Date.now() - started,
        retrievalScores: [],
      },
    };
  }

  let g: Grounding;
  if (affirmative) {
    g = { intent: "price_query", factsBlock: affirmative.factsBlock, citations: affirmative.citations, retrievalScores: [] };
  } else {
    g = ground(message);
    updatePendingPricingOffer(sessionId, g);
  }

  // Nothing matched closely enough to ground an answer on — say so directly
  // rather than letting the model improvise around empty facts.
  if (!g.factsBlock.trim()) {
    return {
      answer: noFactsFallback(g),
      intent: g.intent,
      handoff: true,
      citations: g.citations,
      meta: {
        mode: config.llm.mode,
        model: config.llm.mode === "live" ? config.llm.model : undefined,
        latencyMs: Date.now() - started,
        retrievalScores: g.retrievalScores,
      },
    };
  }

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
  sessionId: string | undefined,
  onMeta: (meta: { intent: Intent; citations: Citation[] }) => void,
): AsyncGenerator<string, void, unknown> {
  const bypass = deterministicReply(message);
  if (bypass) {
    clearPendingPricingOffer(sessionId);
    onMeta({ intent: bypass.intent, citations: [] });
    yield bypass.text;
    return;
  }

  const affirmative = resolveAffirmative(message, sessionId);
  if (affirmative === "clarify") {
    onMeta({ intent: "out_of_scope", citations: [] });
    yield CLARIFY_TEXT;
    return;
  }

  let g: Grounding;
  if (affirmative) {
    g = { intent: "price_query", factsBlock: affirmative.factsBlock, citations: affirmative.citations, retrievalScores: [] };
  } else {
    g = ground(message);
    updatePendingPricingOffer(sessionId, g);
  }
  onMeta({ intent: g.intent, citations: g.citations });

  if (!g.factsBlock.trim()) {
    yield noFactsFallback(g);
    return;
  }

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
