// Minimal in-memory conversation memory. The pipeline is otherwise fully
// stateless (each message routed independently), but several things only
// make sense in light of what was already said, so this remembers them,
// keyed by the widget's per-session id:
//   - an outstanding pricing offer, for a short "yes please" reply;
//   - the last course/service discussed, for a substantive follow-up reply
//     that doesn't name a course itself (e.g. answering a clarifying
//     question about group size) — see getLastTopic/setLastTopic below;
//   - the visitor's own recent messages, verbatim, so a later turn doesn't
//     ask them to repeat something already said — see getRecentMessages;
//   - every distinct service touched on this session, for a "so far we've
//     covered X and Y" progress recap — see getDiscussedTopics.
//
// PoC-scope deliberately: a plain in-memory Map resets on restart and doesn't
// survive multiple server instances. Fine for a single-process demo; revisit
// (e.g. a short-TTL external store) if this graduates past Phase 1.

import type { Intent } from "./types.js";

interface PendingOffer {
  serviceIds: string[];
  updatedAt: number;
}

const OFFER_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for a normal reply gap

const pendingOffers = new Map<string, PendingOffer>();

// The service(s) discussed if a pricing offer is still outstanding for this
// session, or undefined if there's nothing pending (no session id, no offer
// made, visitor already used it, or it's gone stale).
export function getPendingPricingOffer(sessionId: string | undefined): string[] | undefined {
  if (!sessionId) return undefined;
  const offer = pendingOffers.get(sessionId);
  if (!offer) return undefined;
  if (Date.now() - offer.updatedAt > OFFER_TTL_MS) {
    pendingOffers.delete(sessionId);
    return undefined;
  }
  return offer.serviceIds;
}

export function setPendingPricingOffer(sessionId: string | undefined, serviceIds: string[]): void {
  if (!sessionId || !serviceIds.length) return;
  pendingOffers.set(sessionId, { serviceIds, updatedAt: Date.now() });
}

export function clearPendingPricingOffer(sessionId: string | undefined): void {
  if (!sessionId) return;
  pendingOffers.delete(sessionId);
}

interface LastTopic {
  serviceIds: string[];
  intent: Intent;
  updatedAt: number;
}

const TOPIC_TTL_MS = 10 * 60 * 1000;

const lastTopics = new Map<string, LastTopic>();

// The course(s)/intent last discussed for this session, or undefined if
// there's nothing recent enough to fall back on. Used when a reply doesn't
// name a course itself — see pipeline.ts's ground() for how this stays
// scoped to genuine follow-ups (a reply naming a different service always
// wins, since it never needs this fallback in the first place).
export function getLastTopic(sessionId: string | undefined): LastTopic | undefined {
  if (!sessionId) return undefined;
  const topic = lastTopics.get(sessionId);
  if (!topic) return undefined;
  if (Date.now() - topic.updatedAt > TOPIC_TTL_MS) {
    lastTopics.delete(sessionId);
    return undefined;
  }
  return topic;
}

export function setLastTopic(sessionId: string | undefined, serviceIds: string[], intent: Intent): void {
  if (!sessionId || !serviceIds.length) return;
  lastTopics.set(sessionId, { serviceIds, intent, updatedAt: Date.now() });
}

// A short rolling window of the visitor's own recent messages, verbatim —
// the platform-level fix for "don't ask again for something already said."
// The model is never sent chat history (see pipeline.ts's messagesFor: each
// turn is system prompt + this ONE user turn, deliberately, so a live/mock
// model can't drift from accumulated context) — but that means anything a
// visitor volunteers in one turn (e.g. "I'm a complete beginner, just me")
// is otherwise invisible on a later, differently-worded turn ("how much is
// forklift training?"). This is threaded into that later turn's facts block
// instead, labelled as context, not fact — see buildUserTurn in prompt.ts.
interface History {
  messages: string[];
  updatedAt: number;
}

const HISTORY_TTL_MS = 10 * 60 * 1000;
const MAX_HISTORY = 3;

const histories = new Map<string, History>();

export function getRecentMessages(sessionId: string | undefined): string[] {
  if (!sessionId) return [];
  const h = histories.get(sessionId);
  if (!h) return [];
  if (Date.now() - h.updatedAt > HISTORY_TTL_MS) {
    histories.delete(sessionId);
    return [];
  }
  return h.messages;
}

// Never call this with a message containing personal information — see the
// containsPersonalInfo guard at each pipeline.ts call site. That message is
// already declined before grounding (golden rule 5); recording it here would
// otherwise resurface it into a later turn's prompt.
export function recordMessage(sessionId: string | undefined, message: string): void {
  if (!sessionId) return;
  const h = histories.get(sessionId) ?? { messages: [], updatedAt: Date.now() };
  h.messages.push(message);
  if (h.messages.length > MAX_HISTORY) h.messages.shift();
  h.updatedAt = Date.now();
  histories.set(sessionId, h);
}

// The distinct services touched on anywhere in this session, in the order
// first mentioned — for the "progress recap" (rule 27): a visitor who's
// asked about the medical, then CPC, then booking practical training should
// get a short "so far we've covered X and Y, next step Z" summary, which
// needs the WHOLE journey so far, not just getLastTopic's single most-recent
// topic (that one is for resolving an ambiguous next message, and gets
// overwritten every turn) or getRecentMessages' short 3-message window
// (long enough for "don't ask again," too short for a multi-turn recap).
interface DiscussedTopics {
  serviceIds: string[];
  updatedAt: number;
}

const TOPICS_TTL_MS = 10 * 60 * 1000;

const discussedTopics = new Map<string, DiscussedTopics>();

export function getDiscussedTopics(sessionId: string | undefined): string[] {
  if (!sessionId) return [];
  const t = discussedTopics.get(sessionId);
  if (!t) return [];
  if (Date.now() - t.updatedAt > TOPICS_TTL_MS) {
    discussedTopics.delete(sessionId);
    return [];
  }
  return t.serviceIds;
}

export function recordDiscussedTopics(sessionId: string | undefined, serviceIds: string[]): void {
  if (!sessionId || !serviceIds.length) return;
  const existing = getDiscussedTopics(sessionId); // already TTL-checked
  const merged = existing.slice();
  for (const id of serviceIds) {
    if (!merged.includes(id)) merged.push(id);
  }
  discussedTopics.set(sessionId, { serviceIds: merged, updatedAt: Date.now() });
}
