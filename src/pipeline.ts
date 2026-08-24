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
import { courseComparisonMd, coursesByJobMd, faqs, serviceById } from "./knowledge.js";
import { complete, stream, type ChatMessage } from "./llm.js";
import {
  buildUserTurn,
  CALLBACK_DECLINE_TEXT,
  CAR_LESSONS_OUT_OF_SCOPE_TEXT,
  CLARIFY_TEXT,
  CONTACT_DETAILS_TEXT,
  CONTACT_ON_BEHALF_TEXT,
  GREETING_TEXT,
  HANDOFF_TEXT,
  INSTRUCTOR_SELECTION_TEXT,
  IRRELEVANT_TEXT,
  PERSONAL_INFO_TEXT,
  SYSTEM_PROMPT,
  THANKS_TEXT,
  UNSURE_TEXT,
} from "./prompt.js";
import {
  containsPersonalInfo,
  isBroadOfferingQuery,
  isCallbackRequest,
  isCourseComparisonQuery,
  isJobQualificationQuery,
  isContactOnBehalfRequest,
  isGreeting,
  isHowToContactQuery,
  isInstructorSelectionRequest,
  isOrdinaryCarLessonQuery,
  isShortAffirmative,
  isThanks,
  route,
} from "./intent.js";
import { search } from "./retrieval.js";
import {
  clearPendingPricingOffer,
  getDiscussedTopics,
  getLastTopic,
  getPendingPricingOffer,
  getRecentMessages,
  recordDiscussedTopics,
  recordMessage,
  setLastTopic,
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
function ground(message: string, sessionId: string | undefined): Grounding {
  let { intent, serviceIds } = route(message);

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

  // A standalone "thanks"-shaped message gets a fixed acknowledgement +
  // offer to help further, rather than being routed as an unanswerable
  // question. Checked before the topic-continuity fallback below, so it
  // can't get its intent mislabelled as whatever course was last discussed.
  if (isThanks(message)) {
    return {
      intent,
      factsBlock: `SCOPE ${THANKS_TEXT}`,
      citations: [],
      retrievalScores: [],
    };
  }

  // Staying on topic through follow-up answers: a reply that names no
  // course/service of its own is most likely answering a clarifying
  // question the bot just asked about whatever was last discussed (e.g. "I'm
  // a beginner doing it solo" after the bot asked about group size and
  // experience for forklift pricing) — apply it to that same topic rather
  // than losing context and routing fresh. A reply that DOES name a
  // different service always wins here (serviceIds is already non-empty
  // from THIS message in that case), so a genuine topic switch is never
  // overridden. Only borrow the last intent too when this message didn't
  // signal one of its own (price/availability hints already set a specific
  // intent via route() above) — e.g. "when can I start?" should stay an
  // availability question about the same course, not get forced to price.
  // Checked after the fixed-text short-circuits above, so a greeting/thanks/
  // car-lesson message never gets its own intent overridden by a stale
  // topic just because it happens to name no service.
  if (serviceIds.length === 0) {
    const lastTopic = getLastTopic(sessionId);
    if (lastTopic) {
      serviceIds = lastTopic.serviceIds;
      if (intent === "out_of_scope" || intent === "faq_query") {
        intent = lastTopic.intent;
      }
    }
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

  // "How does X differ from Y" / "what's the difference between the
  // courses" — grounded on the dedicated comparison reference doc instead
  // of ordinary retrieval, which can only surface one best-matching fact at
  // a time and has no way to actually compare across several.
  if (isCourseComparisonQuery(message)) {
    return {
      intent: "faq_query",
      factsBlock: `COURSE COMPARISON REFERENCE:\n${courseComparisonMd}`,
      citations: [{ kind: "faq", id: "course-comparison", label: "NEDS Course Comparison" }],
      retrievalScores: [],
    };
  }

  // "What do I need for job X" / "what can I do with qualification Y" —
  // both directions of the same mapping, answered from the dedicated
  // job-guide reference doc rather than ordinary retrieval, which has
  // nothing to match a job/career framing against.
  if (isJobQualificationQuery(message)) {
    return {
      intent: "faq_query",
      factsBlock: `COURSES BY JOB REFERENCE:\n${coursesByJobMd}`,
      citations: [{ kind: "faq", id: "courses-by-job", label: "NEDS Courses by Job" }],
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

// Remembers the course(s) this turn was actually about, for ground()'s
// topic-continuity fallback on the visitor's next reply — broader than
// updatePendingPricingOffer above (that one is specifically "waiting on a
// bare yes"; this is "what were we just talking about" for any substantive
// follow-up). Covers price/service/availability turns, the only intents
// ground() ever borrows a stale topic's intent for.
function updateLastTopic(sessionId: string | undefined, g: Grounding): void {
  if (g.intent !== "price_query" && g.intent !== "service_query" && g.intent !== "training_availability_query") {
    return;
  }
  const serviceIds = g.citations.filter((c) => c.kind === "service").map((c) => c.id);
  if (serviceIds.length) {
    setLastTopic(sessionId, serviceIds, g.intent);
    recordDiscussedTopics(sessionId, serviceIds);
  }
}

// Fixed policy replies that are decided before grounding and never reach the
// model — each is a hard refusal/decline where the exact wording matters
// (privacy, safety, fairness policy) more than letting the model paraphrase.
// Checked in order; the first match wins.
const DETERMINISTIC_REPLIES: { test: (message: string) => boolean; intent: Intent; text: string }[] = [
  { test: containsPersonalInfo, intent: "out_of_scope", text: PERSONAL_INFO_TEXT },
  // Checked ahead of isCallbackRequest: both isHowToContactQuery ("how can I
  // get in touch") and isContactOnBehalfRequest ("get in touch with the
  // office for me") overlap with LEAD_HINTS ("get in touch"), but are more
  // specific — asking HOW to reach NEDS, or asking the bot to reach NEDS FOR
  // them, are different questions from "NEDS, please contact ME".
  { test: isHowToContactQuery, intent: "faq_query", text: CONTACT_DETAILS_TEXT },
  { test: isContactOnBehalfRequest, intent: "lead_or_callback_request", text: CONTACT_ON_BEHALF_TEXT },
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

// Deterministic follow-up chips shown under every reply — computed from what
// was actually grounded, never left to the model (same "facts outside the
// model" reasoning as the rest of the approved content: a hallucinated
// suggestion button is just as much a risk as a hallucinated price). Capped
// at two so they read as options, not a wall of buttons. The widget renders
// each as a clickable chip that sends its text as the visitor's next
// message — see public/widget.html.
function suggestionsFor(intent: Intent, citations: Citation[]): string[] {
  switch (intent) {
    case "price_query":
      return ["How do I book a course?", "What courses do you offer?"];
    case "service_query": {
      const hasPrice = citations.some((c) => c.kind === "price");
      return hasPrice
        ? ["How do I book a course?"]
        : ["How much does that cost?", "How do I book a course?"];
    }
    case "training_availability_query":
      return ["How do I book a course?"];
    case "faq_query":
      return ["What courses do you offer?"];
    default:
      return ["What courses do you offer?", "How much does a course cost?"];
  }
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

function messagesFor(
  message: string,
  factsBlock: string,
  recentMessages?: string[],
  discussedTopics?: string[],
): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserTurn(message, factsBlock, recentMessages, discussedTopics) },
  ];
}

// Human-readable service names for getDiscussedTopics' serviceIds, in the
// order first mentioned — only surfaced once there are 2+ (rule 27's recap
// is for a multi-step journey; one topic isn't a "progress" summary yet).
function discussedTopicNames(sessionId: string | undefined): string[] {
  const ids = getDiscussedTopics(sessionId);
  if (ids.length < 2) return [];
  return ids.map((id) => serviceById.get(id)?.name).filter((n): n is string => Boolean(n));
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

  // Captured BEFORE recording this message below, so it's the history from
  // EARLIER turns only — this message is already the "VISITOR QUESTION"
  // itself and would otherwise duplicate into both sections. Never recorded
  // when it contains personal info, which is declined below and must not
  // resurface into a future prompt either.
  const recentMessages = getRecentMessages(sessionId);
  if (!containsPersonalInfo(message)) recordMessage(sessionId, message);

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
      suggestions: suggestionsFor(bypass.intent, []),
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
      suggestions: suggestionsFor("out_of_scope", []),
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
    g = ground(message, sessionId);
    updatePendingPricingOffer(sessionId, g);
  }
  updateLastTopic(sessionId, g);

  // Nothing matched closely enough to ground an answer on — say so directly
  // rather than letting the model improvise around empty facts.
  if (!g.factsBlock.trim()) {
    return {
      answer: noFactsFallback(g),
      intent: g.intent,
      handoff: true,
      citations: g.citations,
      suggestions: suggestionsFor(g.intent, g.citations),
      meta: {
        mode: config.llm.mode,
        model: config.llm.mode === "live" ? config.llm.model : undefined,
        latencyMs: Date.now() - started,
        retrievalScores: g.retrievalScores,
      },
    };
  }

  const result = await complete(messagesFor(message, g.factsBlock, recentMessages, discussedTopicNames(sessionId)));

  const handoff = !result.ok;
  return {
    answer: handoff ? HANDOFF_TEXT : result.text,
    intent: g.intent,
    handoff,
    citations: g.citations,
    suggestions: suggestionsFor(g.intent, g.citations),
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
  onMeta: (meta: { intent: Intent; citations: Citation[]; suggestions: string[] }) => void,
): AsyncGenerator<string, void, unknown> {
  // See answer()'s comment: captured before recording, so it's earlier
  // turns only.
  const recentMessages = getRecentMessages(sessionId);
  if (!containsPersonalInfo(message)) recordMessage(sessionId, message);

  const bypass = deterministicReply(message);
  if (bypass) {
    clearPendingPricingOffer(sessionId);
    onMeta({ intent: bypass.intent, citations: [], suggestions: suggestionsFor(bypass.intent, []) });
    yield bypass.text;
    return;
  }

  const affirmative = resolveAffirmative(message, sessionId);
  if (affirmative === "clarify") {
    onMeta({ intent: "out_of_scope", citations: [], suggestions: suggestionsFor("out_of_scope", []) });
    yield CLARIFY_TEXT;
    return;
  }

  let g: Grounding;
  if (affirmative) {
    g = { intent: "price_query", factsBlock: affirmative.factsBlock, citations: affirmative.citations, retrievalScores: [] };
  } else {
    g = ground(message, sessionId);
    updatePendingPricingOffer(sessionId, g);
  }
  updateLastTopic(sessionId, g);
  onMeta({ intent: g.intent, citations: g.citations, suggestions: suggestionsFor(g.intent, g.citations) });

  if (!g.factsBlock.trim()) {
    yield noFactsFallback(g);
    return;
  }

  try {
    let any = false;
    for await (const delta of stream(messagesFor(message, g.factsBlock, recentMessages, discussedTopicNames(sessionId)))) {
      any = true;
      yield delta;
    }
    if (!any) yield HANDOFF_TEXT;
  } catch (err) {
    console.error(`[pipeline] stream failed: ${err instanceof Error ? err.name : err}`);
    yield HANDOFF_TEXT;
  }
}
