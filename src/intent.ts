// Rule-based intent router. Fast, deterministic, no model call — appropriate for
// the deliberately small intent set. It also surfaces which services the message
// is about, which drives deterministic fact lookup and retrieval.

import { services } from "./knowledge.js";
import { search } from "./retrieval.js";
import type { Intent } from "./types.js";

const PRICE_HINTS = [
  "price", "prices", "cost", "costs", "how much", "fee", "fees", "charge",
  "rate", "rates", "£", "pounds", "quote", "expensive", "cheap",
];

const AVAILABILITY_HINTS = [
  "availab", "available", "when", "next course", "next date", "dates",
  "start date", "slot", "spaces", "space", "book a place", "openings",
  "this week", "next week", "week commencing",
];

const LEAD_HINTS = [
  "call me", "callback", "call back", "ring me", "phone me", "contact me",
  "get in touch", "my number", "my email", "reach me", "someone to call",
];

const GREETING = ["hi", "hello", "hey", "good morning", "good afternoon"];

function has(text: string, needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

// Match a keyword against the message. Simple single tokens (hgv, cpc, adr) match
// on WORD BOUNDARIES so "car" can't hide inside "car licence"; multi-word or
// symbol keywords (e.g. "category c", "c+e", "7.5t") fall back to substring.
function keywordHit(text: string, keyword: string): boolean {
  const k = keyword.toLowerCase();
  if (/^[a-z0-9]+$/.test(k)) {
    return new RegExp(`\\b${k}\\b`).test(text);
  }
  return text.includes(k);
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

export interface Routed {
  intent: Intent;
  serviceIds: string[];
}

export function route(message: string): Routed {
  const t = message.toLowerCase().trim();
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
