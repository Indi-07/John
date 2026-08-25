// Rule-based intent router. Fast, deterministic, no model call — appropriate for
// the deliberately small intent set. It also surfaces which services the message
// is about, which drives deterministic fact lookup and retrieval.

import { services } from "./knowledge.js";
import { search } from "./retrieval.js";
import type { Intent } from "./types.js";

const PRICE_HINTS = [
  "price", "prices", "cost", "costs", "how much", "fee", "fees", "charge",
  "rate", "rates", "£", "pounds", "quote", "expensive", "cheap",
  "deposit", "deposits",
];

const AVAILABILITY_HINTS = [
  "availab", "available", "when", "next course", "next date", "dates",
  "start date", "slot", "spaces", "space", "book a place", "openings",
  "this week", "next week", "week commencing", "starting soon", "start soon",
  "coming up", "upcoming", "next start", "next intake", "places left",
];

const LEAD_HINTS = [
  "call me", "callback", "call back", "ring me", "phone me", "contact me",
  "get in touch", "my number", "my email", "reach me", "someone to call",
];

const GREETING = ["hi", "hello", "hey", "good morning", "good afternoon"];

export function isGreeting(text: string): boolean {
  return GREETING.includes(text.toLowerCase().trim());
}

// A standalone "thanks"-shaped message (not "thanks, but also...") gets a
// fixed acknowledgement + offer to help further — see THANKS_TEXT. Matched
// as a whole message, same conservative approach as isGreeting/
// isShortAffirmative, so a thank-you attached to a real follow-up question
// still routes normally instead of being swallowed by this reply.
const THANKS = [
  "thanks", "thank you", "thanks a lot", "thank you so much", "thanks so much",
  "many thanks", "much appreciated", "appreciate it", "thanks a bunch",
  "cheers", "ta", "thankyou", "thx", "ty",
];

export function isThanks(text: string): boolean {
  return THANKS.includes(text.toLowerCase().trim().replace(/[.!]+$/, ""));
}

// A short reply that only makes sense as an answer to something the bot just
// offered ("Want me to run through pricing too?"). Matched as a whole
// message, not a substring — deliberately conservative, since the point is
// to only claim messages that are UNAMBIGUOUSLY just "yes" in some form, and
// let anything with real content go through normal routing instead.
const AFFIRMATIVE_REPLIES = [
  "yes", "yes please", "yeah", "yeah please", "yep", "yup", "sure",
  "sure please", "please", "please do", "go on", "go ahead", "ok", "okay",
  "sounds good", "please do so", "yes please do",
];

export function isShortAffirmative(text: string): boolean {
  const t = text.toLowerCase().trim().replace(/[.!]+$/, "");
  return AFFIRMATIVE_REPLIES.includes(t);
}

// NEDS chat does not take callback requests or contact details at all (see
// CALLBACK_DECLINE_TEXT) — this is checked deterministically, ahead of and
// independent of intent routing, so the pipeline can decline before ever
// asking for a name or number.
export function isCallbackRequest(text: string): boolean {
  return has(text.toLowerCase(), LEAD_HINTS);
}

// A visitor asking the BOT to reach NEDS on their behalf ("can you call the
// office for me?") is the opposite direction from isCallbackRequest (NEDS
// contacting the visitor) — a distinct case with its own reply
// (CONTACT_ON_BEHALF_TEXT). Requires an action word AND a target word
// (office/team/them/NEDS) together, so this can't be triggered by "office"
// or "contact" merely appearing somewhere in an unrelated question (that
// word overlap was previously matching random course/FAQ content instead).
const CONTACT_ACTION_WORDS = [
  "call", "contact", "email", "phone", "ring", "message", "reach out",
  "get in touch",
];
const CONTACT_TARGET_WORDS = ["office", "them", "team", "neds"];
const ON_BEHALF_WORDS = ["for me", "on my behalf", "for us"];

export function isContactOnBehalfRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (!has(t, CONTACT_ACTION_WORDS) || !has(t, CONTACT_TARGET_WORDS)) return false;
  return has(t, ON_BEHALF_WORDS) || /\byou\b/.test(t);
}

// A visitor asking HOW to reach NEDS themselves wants the actual phone/email
// immediately (CONTACT_DETAILS_TEXT) — this must win over isCallbackRequest
// (whose LEAD_HINTS includes "get in touch", which would otherwise wrongly
// decline "how can I get in touch?" instead of answering it) and never touch
// retrieval, which was matching "office" in this phrasing against the
// unrelated "transport-office awareness training" course. Phrase-matched
// (not composed from word-lists) since the examples are a specific,
// enumerable set of "how do/can I/you ..." shapes, including the
// ungrammatical "how do contact the office".
const HOW_TO_CONTACT_HINTS = [
  "how do i contact", "how can i contact", "how do you contact",
  "how do contact", "how can you contact",
  "how do i get in touch", "how can i get in touch", "how do you get in touch",
  "how do i reach", "how can i reach", "how do you reach",
];

export function isHowToContactQuery(text: string): boolean {
  return has(text.toLowerCase(), HOW_TO_CONTACT_HINTS);
}

// NEDS does not let clients choose/request/specify their instructor, by
// gender, age, race or any other characteristic (see
// INSTRUCTOR_SELECTION_TEXT). Gated on the word "instructor" so generic uses
// of "choose"/"prefer" elsewhere (e.g. "can I choose classroom or practical
// CPC?") aren't caught.
const INSTRUCTOR_WORD = /\binstructors?\b/i;
const INSTRUCTOR_SELECTION_WORDS = [
  "choose", "choice", "request", "specify", "specific", "particular",
  "prefer", "preference", "pick", "select", "same", "different", "change",
  "swap", "gender", "male", "female", "man", "woman", "men", "women",
  "age", "older", "younger", "young", "elderly",
  "race", "racial", "ethnicity", "ethnic", "nationality",
];

export function isInstructorSelectionRequest(text: string): boolean {
  if (!INSTRUCTOR_WORD.test(text)) return false;
  return has(text.toLowerCase(), INSTRUCTOR_SELECTION_WORDS);
}

// A visitor volunteering a name, date of birth or driving-licence number is a
// privacy risk this public bot must not process or forward to the model —
// see the "keep sensitive data out of public chat" principle in
// self-hosted-implementation-plan.md. Detected deterministically, not left to
// the model to notice and refuse.
// UK driving licence numbers are a fixed 16 characters: 5 letters from the
// surname (padded with "9" if short), 6 digits encoding DOB/gender, then 5
// more alphanumeric characters (initials, check digits/letter).
const UK_LICENCE_NUMBER = /\b[A-Z9]{5}\d{6}[A-Z0-9]{5}\b/i;
const DOB_TRIGGERS = [/\bdob\b/i, /\bd\.o\.b\.?/i, /date of birth/i, /born on/i, /my birthday is/i];
const NAME_TRIGGERS = [/my name is/i, /my name'?s/i, /\bi'?m called\b/i, /\bi am called\b/i];
const EMAIL_ADDRESS = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;

// A run of 10+ digits (spaces/hyphens allowed between them) reads as a phone
// number regardless of exact formatting — deliberately loose rather than
// matching only "proper" UK layouts, since what matters here is catching any
// number the visitor volunteers, not validating it.
function hasPhoneNumber(text: string): boolean {
  const candidates = text.match(/\+?\d[\d\s-]{7,}\d/g) ?? [];
  return candidates.some((c) => c.replace(/\D/g, "").length >= 10);
}

export function containsPersonalInfo(text: string): boolean {
  if (UK_LICENCE_NUMBER.test(text)) return true;
  if (EMAIL_ADDRESS.test(text)) return true;
  if (hasPhoneNumber(text)) return true;
  return DOB_TRIGGERS.some((re) => re.test(text)) || NAME_TRIGGERS.some((re) => re.test(text));
}

// NEDS is HGV/professional-training only and does not teach ordinary car
// driving. "car" alone is too broad to gate on (it also appears inside the
// approved B+E "car and trailer" service), so this requires BOTH the word
// "car"/"cars" AND a lesson/learn/teach-shaped word, in either order and
// anywhere in the message — not a fixed list of exact phrases, which missed
// real phrasings like "lessons for a car" or "teach me to drive my car". It
// backs off if the message also names a real NEDS service so a genuine
// B+E/HGV query is never blocked.
const CAR_WORD = /\bcars?\b/;
const LESSON_TOPIC_WORDS = [
  "lesson", "lessons", "learn", "learner", "teach", "instructor",
  "driving school", "driving test",
];
const CAR_LESSON_EXCEPTIONS = [
  "trailer", "towing", "tow", "caravan", "horsebox", "b+e", "hgv", "lorry",
  "lgv", "cpc", "adr", "forklift", "medical",
];

export function isOrdinaryCarLessonQuery(text: string): boolean {
  const t = text.toLowerCase();
  if (!CAR_WORD.test(t)) return false;
  if (!has(t, LESSON_TOPIC_WORDS)) return false;
  return !has(t, CAR_LESSON_EXCEPTIONS);
}

function has(text: string, needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

// Match a keyword against the message. Simple single tokens (hgv, cpc, adr) match
// on WORD BOUNDARIES so "car" can't hide inside "car licence"; multi-word or
// symbol keywords (e.g. "category c", "c+e", "7.5t") fall back to substring.
function keywordHit(text: string, keyword: string): boolean {
  const k = keyword.toLowerCase();
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word-bounded on both ends (not a plain substring) so a keyword like
  // "category c" doesn't match inside "category c1" or "category c+e" —
  // \b alone blocks the digit case (both are word chars, no boundary
  // between them) but not "+" (a non-word char, so \b sees a boundary
  // there); the trailing (?!\+) closes that gap specifically.
  return new RegExp(`\\b${escaped}\\b(?!\\+)`).test(text);
}

// Which services does this message mention? Uses keyword hits first, then a
// retrieval fallback so paraphrases still map to a service.
export function servicesMentioned(text: string): string[] {
  const t = text.toLowerCase();
  const direct = services
    .filter(
      (s) =>
        s.keywords.some((k) => keywordHit(t, k)) ||
        t.includes(s.name.toLowerCase()),
    )
    .map((s) => s.id);
  if (direct.length) return direct;

  // Fall back to retrieval; keep service hits only.
  return search(text, 3)
    .filter((h) => h.kind === "service")
    .map((h) => h.id);
}

// A broad "what do you offer" question names no specific service, so
// servicesMentioned() comes back empty and keyword/retrieval routing has
// nothing to grab onto — it was falling through to a random tangential FAQ
// (or nothing at all) instead of the full course list. Detected explicitly
// so it always gets the "list everything" treatment (see
// pipeline.ts/BROAD_OFFER_LIST), never a single narrow answer.
const BROAD_OFFER_HINTS = [
  "what courses", "what training", "what do you offer", "what do you provide",
  "what do you do", "what can i book", "what services", "which courses",
  "what qualifications", "range of courses", "list of courses",
];

export function isBroadOfferingQuery(text: string): boolean {
  const t = text.toLowerCase();
  if (!has(t, BROAD_OFFER_HINTS)) return false;
  return servicesMentioned(t).length === 0;
}

// A question about how courses relate to or differ from one another (rather
// than about one course, or the full list) — routed to the course-comparison
// reference doc instead of ordinary retrieval, which has no way to answer a
// "how does X differ from Y" question well since it's built to find the
// single best-matching fact, not to compare across several.
//
// Split into three groups rather than one flat list because the general
// "lead with what was actually asked" rule (rule 39 in prompt.ts) needs to
// know not just THAT this is a comparison question, but which half of it —
// differences or similarities — was actually asked about, so the reference
// doc's Similarities/Differences paragraphs can be reordered to match (see
// comparisonFocus() below and humanizeReferenceSection() in src/llm.ts).
const DIFFERENCE_HINTS = [
  "difference between", "differences between", "what's the difference",
  "differ", // covers "differ(s)"/"differing" generally — e.g. "how does
  // c+e differ from b+e?" (no pronoun, no "between") as well as "how do
  // they differ"/"how does it differ".
];
const SIMILARITY_HINTS = [
  "have in common", "in common", "similar", "similarit", "alike",
];
// Genuinely either-direction phrasing — no explicit signal for which half
// of the comparison was actually wanted, so comparisonFocus() below falls
// back to "neutral" (keep the doc's default order) rather than guessing.
const NEUTRAL_COMPARISON_HINTS = ["compare", "comparison", "vs ", "versus", "which is better"];

export function isCourseComparisonQuery(text: string): boolean {
  const t = text.toLowerCase();
  return has(t, DIFFERENCE_HINTS) || has(t, SIMILARITY_HINTS) || has(t, NEUTRAL_COMPARISON_HINTS);
}

export type ComparisonFocus = "differences" | "similarities" | "neutral";

// Which half of a comparison question was actually asked about — see
// DIFFERENCE_HINTS/SIMILARITY_HINTS's comment above. A message matching
// both (e.g. "how are C and C1 similar, and how do they differ?") or
// neither specifically (e.g. "compare C and C1") has no single clear
// signal, so this returns "neutral" rather than guessing — the caller
// keeps the doc's current default order for that case.
export function comparisonFocus(text: string): ComparisonFocus {
  const t = text.toLowerCase();
  const wantsDifferences = has(t, DIFFERENCE_HINTS);
  const wantsSimilarities = has(t, SIMILARITY_HINTS);
  if (wantsDifferences && !wantsSimilarities) return "differences";
  if (wantsSimilarities && !wantsDifferences) return "similarities";
  return "neutral";
}

// Either direction of "which qualification for which job" — what someone
// needs for a job ("what do I need to become a...") or what a qualification
// is actually for ("what can I do with a C1 licence") — routed to the
// job-mapping reference doc, which answers both symmetrically, rather than
// ordinary retrieval, which has no job/career framing to match against at all.
const JOB_QUALIFICATION_HINTS = [
  "what job", "what jobs", "what career", "what careers",
  "what can i do with", "what could i do with", "what's it used for",
  "what is it used for", "what's this used for", "used for",
  "what do i need to become", "what do i need for a career",
  "what qualification do i need", "what qualifications do i need",
  "what course do i need to become", "what training do i need to become",
  "what do i need to drive", // e.g. "what do I need to drive a skip
  // lorry?" — job-framed by an activity/vehicle rather than "become a
  // ___", which none of the "to become"/"career"/"job as a" phrasings
  // above catch.
  "career as a", "work as a", "job as a", "need to work as a",
];

export function isJobQualificationQuery(text: string): boolean {
  return has(text.toLowerCase(), JOB_QUALIFICATION_HINTS);
}

export interface Routed {
  intent: Intent;
  serviceIds: string[];
}

export function route(message: string): Routed {
  const t = message.toLowerCase().trim();

  // Check this before any service matching: retrieval/keyword fallbacks can
  // otherwise pull in the B+E "car and trailer" service just because the
  // word "car" appears, which would wrongly look like NEDS offers car
  // lessons. Decide this deterministically instead of hoping retrieval
  // never misfires.
  if (isOrdinaryCarLessonQuery(t)) return { intent: "out_of_scope", serviceIds: [] };

  const serviceIds = servicesMentioned(t);

  if (has(t, LEAD_HINTS)) return { intent: "lead_or_callback_request", serviceIds };
  if (has(t, AVAILABILITY_HINTS)) return { intent: "training_availability_query", serviceIds };
  if (has(t, PRICE_HINTS)) return { intent: "price_query", serviceIds };

  // A pure greeting with nothing else is out of scope for a narrow bot, but we
  // handle it warmly rather than refusing.
  if (GREETING.includes(t)) return { intent: "out_of_scope", serviceIds };

  // If we found a relevant service or a strong FAQ hit, treat as a service/FAQ query.
  const topFaq = search(message, 1)[0];
  if (serviceIds.length || (topFaq && topFaq.kind === "faq" && topFaq.score > 1.5)) {
    return { intent: serviceIds.length ? "service_query" : "faq_query", serviceIds };
  }

  return { intent: "out_of_scope", serviceIds };
}
