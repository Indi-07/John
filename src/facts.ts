// Deterministic fact formatting. Prices and service details are read verbatim
// from the approved data and turned into plain text the model may quote but must
// not alter. This is the "facts outside the model" guarantee in code form.

import { prices, pricesByService, serviceById, services } from "./knowledge.js";
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
// that grounds the model, plus the citations we can show the user.
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
