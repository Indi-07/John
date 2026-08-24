// Deterministic fact formatting. Prices and service details are read verbatim
// from the approved data and turned into plain text the model may quote but must
// not alter. This is the "facts outside the model" guarantee in code form.

import { prices, pricesByService, serviceById, services } from "./knowledge.js";
import { DRIVER_MEDICALS_URL } from "./prompt.js";
import type { Citation, Price, Service } from "./types.js";

function gbp(amount: number): string {
  return `£${amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2)}`;
}

export function priceLine(p: Price): string {
  const includes = p.includes?.length ? ` (includes: ${p.includes.join(", ")})` : "";
  const note = p.note ? ` — ${p.note}` : "";
  return `${p.label}: ${gbp(p.amountGBP)} ${p.unit}${includes}${note}`;
}

export function serviceLine(s: Service): string {
  return `${s.name}: ${s.summary}`;
}

// Given a set of retrieved/relevant service ids, build the approved-fact block
// that grounds the model, plus the citations we can show the user. Used for
// price_query, where the price is the direct subject of the question — so
// naming what it's for (the service line) is necessary context, not an
// unrequested extra.
export function factsFor(serviceIds: string[]): {
  block: string;
  citations: Citation[];
} {
  const lines: string[] = [];
  const citations: Citation[] = [];
  const seen = new Set<string>();

  for (const id of serviceIds) {
    const svc = serviceById.get(id);
    if (!svc || seen.has(id)) continue;
    seen.add(id);

    lines.push(`SERVICE ${serviceLine(svc)}`);
    citations.push({ kind: "service", id: svc.id, label: svc.name });

    for (const p of pricesByService.get(id) ?? []) {
      lines.push(`PRICE ${priceLine(p)}`);
      citations.push({ kind: "price", id: p.id, label: p.label });
    }
  }

  return { block: lines.join("\n"), citations };
}

// Service description only, no price — used for service_query, so "what is
// X" doesn't drag in pricing the visitor didn't ask about. Information
// pacing: answer what was asked, not everything adjacent to it. Also carries
// a DEFINITION line ahead of the SERVICE line — a "what is X" answer should
// explain the thing generically before connecting it to what NEDS offers.
// Whether a service's prerequisite qualification is itself something NEDS
// offers — a fixed, known relationship (see CLAUDE.md), given here as a
// fact rather than left for the model to recall and cross-check against the
// scope line each time. That reasoning-only approach was tried first and
// was unreliable turn to turn (sometimes correct, sometimes dropped
// entirely) — stating it as a fact the model just relays, the same
// "outside the model" treatment as every other approved fact, was reliable
// where asking the model to derive it wasn't.
const PREREQUISITE_NOTES: Record<string, string> = {
  "hgv-ce":
    "This course normally requires already holding a full Category C licence first — NEDS also offers Category C training, so ask which stage the visitor is at. NEDS also offers a combined 7-day Category C plus C+E package that already includes the Category C days as part of itself — if that combined package is what's already under discussion in this conversation, say the Category C part is already built in rather than restating it as something to arrange separately.",
  be: "This course requires a full ordinary car licence first — NEDS does NOT offer car licence training (out of scope), so the visitor would need to get that separately before or alongside this course.",
  adr: "This course requires holding the relevant HGV licence for the vehicle carrying the goods (C1, C or C+E) — NEDS also offers that HGV training, so ask which vehicle/category applies.",
  "driver-cpc":
    "For someone who has never held Driver CPC, the relevant route is Initial CPC (Mod 2 & Mod 4) — this is NOT the same as, and never requires, the 35-hour periodic CPC renewal, which only applies to people already working as qualified professional drivers keeping their CPC valid. NEDS's Category C training and its 7-day combined C+E package already include gaining Initial CPC as part of the course itself, so don't imply it needs arranging separately for someone on one of those; standalone Initial CPC training is also available on its own for anyone not on one of those packages.",
};

export function serviceFactsOnly(serviceIds: string[]): {
  block: string;
  citations: Citation[];
} {
  const lines: string[] = [];
  const citations: Citation[] = [];
  const seen = new Set<string>();

  for (const id of serviceIds) {
    const svc = serviceById.get(id);
    if (!svc || seen.has(id)) continue;
    seen.add(id);

    lines.push(`DEFINITION ${svc.definition}`);
    lines.push(`SERVICE ${serviceLine(svc)}`);
    citations.push({ kind: "service", id: svc.id, label: svc.name });
    const prereq = PREREQUISITE_NOTES[id];
    if (prereq) lines.push(`PREREQUISITE (must be mentioned in your answer, not just used as background) ${prereq}`);
  }

  return { block: lines.join("\n"), citations };
}

// Every price we hold — used when the visitor asks a broad "how much" question.
export function allPricesBlock(): { block: string; citations: Citation[] } {
  const lines = prices.map((p) => `PRICE ${priceLine(p)}`);
  const citations: Citation[] = prices.map((p) => ({
    kind: "price",
    id: p.id,
    label: p.label,
  }));
  return { block: lines.join("\n"), citations };
}

export function allServicesBlock(): { block: string; citations: Citation[] } {
  const lines = services.map((s) => `SERVICE ${serviceLine(s)}`);
  const citations: Citation[] = services.map((s) => ({
    kind: "service",
    id: s.id,
    label: s.name,
  }));
  return { block: lines.join("\n"), citations };
}
