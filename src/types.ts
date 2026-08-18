// Shared contract for the NEDS chat service.
// The widget and the server both speak this shape. Keep it stable — it is the
// public API boundary that Cloudflare will eventually front.

import { z } from "zod";

// The deliberately small intent set from the implementation plan.
export const INTENTS = [
  "price_query",
  "service_query",
  "faq_query",
  "training_availability_query",
  "lead_or_callback_request",
  "out_of_scope",
] as const;

export type Intent = (typeof INTENTS)[number];

// ---- Request / response contract ----

export const ChatRequestSchema = z.object({
  message: z.string().min(1).max(4000),
  // Opaque client-generated id so we can group turns later without cookies.
  sessionId: z.string().max(64).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export interface Citation {
  kind: "service" | "price" | "faq";
  id: string;
  label: string;
}

export interface ChatResponse {
  answer: string;
  intent: Intent;
  // True when we could not answer from approved facts and handed off.
  handoff: boolean;
  citations: Citation[];
  // Non-authoritative debug aid; safe to show in the PoC, hide in production.
  meta: {
    mode: "live" | "mock";
    model?: string;
    latencyMs: number;
    retrievalScores?: { id: string; score: number }[];
  };
}

// ---- Approved knowledge shapes (facts live outside the model) ----

export interface Service {
  id: string;
  name: string;
  category: "hgv" | "be" | "cpc" | "adr" | "forklift" | "medical" | "other";
  // Plain, generic explanation of what the qualification/thing IS — no NEDS
  // branding, no "we offer" framing. Answers "what is X" on its own, before
  // any mention of what NEDS does with it.
  definition: string;
  summary: string;
  keywords: string[];
}

export interface Price {
  id: string;
  serviceId: string;
  label: string;
  amountGBP: number;
  unit: string; // e.g. "per hour", "per course", "per medical"
  includes?: string[];
  note?: string;
}

export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
  keywords: string[];
}
