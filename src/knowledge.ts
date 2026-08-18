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

export const serviceById = new Map(services.map((s) => [s.id, s]));
export const pricesByService = new Map<string, Price[]>();
for (const p of prices) {
  const list = pricesByService.get(p.serviceId) ?? [];
  list.push(p);
  pricesByService.set(p.serviceId, list);
}
