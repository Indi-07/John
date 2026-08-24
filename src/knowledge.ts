// Loads the approved knowledge (facts outside the model) from data/*.json.
// In production these become Supabase reads; the shape stays the same so the
// rest of the service does not care where the data came from.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FaqEntry, Price, Service } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");

function load<T>(file: string, key: string): T[] {
  const raw = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
  return (raw[key] ?? []) as T[];
}

export const services: Service[] = load<Service>("services.json", "services");
export const prices: Price[] = load<Price>("prices.json", "prices");
export const faqs: FaqEntry[] = load<FaqEntry>("faq.json", "faqs");

// A well-sourced comparison of all nine services — similarities, differences,
// and the four natural groups they fall into (licence categories, recurring
// competence requirements, workplace/compliance courses, the D4 medical).
// Copied verbatim from the source at ../../neds-courses-comparison.md (a
// level above this repo) — general UK HGV/PCV licensing facts with external
// citations (gov.uk, DVSA, etc.), not NEDS-specific pricing/policy, so it
// doesn't go through the FAQ/price review process those do. Surfaced only
// for comparison-shaped questions — see isCourseComparisonQuery in
// intent.ts — never loaded into every turn's prompt.
export const courseComparisonMd: string = readFileSync(
  join(dataDir, "course-comparison.md"),
  "utf8",
);

// A job-/situation-led guide to the same nine services — real-world reasons
// someone would need each one, organised by qualification but answering
// both directions symmetrically ("what do I need for job X" and "what can I
// do with qualification Y" are the same underlying mapping read either way).
// Same provenance and same "don't load into every turn" treatment as
// courseComparisonMd above — see isJobQualificationQuery in intent.ts.
export const coursesByJobMd: string = readFileSync(
  join(dataDir, "courses-by-job.md"),
  "utf8",
);

export const serviceById = new Map(services.map((s) => [s.id, s]));
export const pricesByService = new Map<string, Price[]>();
for (const p of prices) {
  const list = pricesByService.get(p.serviceId) ?? [];
  list.push(p);
  pricesByService.set(p.serviceId, list);
}
