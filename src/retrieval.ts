// Compact BM25 over the approved Q&A + service catalogue.
// Deliberately dependency-free: for a narrow, curated corpus this is accurate,
// fast, and runs anywhere. The interface (search -> ranked ids) is what the rest
// of the service depends on, so we can swap in embeddings later without changes.

import { faqs, services } from "./knowledge.js";

export interface Doc {
  id: string;
  kind: "faq" | "service";
  text: string; // searchable text
}

export interface Hit {
  id: string;
  kind: "faq" | "service";
  score: number;
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "do", "does", "i", "you", "we", "my", "me", "it", "how", "what", "can", "with",
  "your", "our", "at", "be", "this", "that", "if", "so", "as",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

// Build the corpus once at load time.
const docs: Doc[] = [
  ...faqs.map((f) => ({
    id: f.id,
    kind: "faq" as const,
    text: `${f.question} ${f.answer} ${f.keywords.join(" ")}`,
  })),
  ...services.map((s) => ({
    id: s.id,
    kind: "service" as const,
    text: `${s.name} ${s.summary} ${s.keywords.join(" ")}`,
  })),
];

const K1 = 1.5;
const B = 0.75;

const docTokens = docs.map((d) => tokenize(d.text));
const docLen = docTokens.map((t) => t.length);
const avgLen = docLen.reduce((a, b) => a + b, 0) / (docLen.length || 1);

// term -> document frequency
const df = new Map<string, number>();
for (const toks of docTokens) {
  for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
}
const N = docs.length;

function idf(term: string): number {
  const n = df.get(term) ?? 0;
  // BM25 idf with +1 to stay non-negative.
  return Math.log(1 + (N - n + 0.5) / (n + 0.5));
}

export function search(query: string, limit = 4): Hit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];

  const scores: Hit[] = docs.map((d, i) => {
    const toks = docTokens[i]!;
    const len = docLen[i]!;
    // term frequencies in this doc
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);

    let score = 0;
    for (const q of new Set(qTokens)) {
      const f = tf.get(q);
      if (!f) continue;
      const denom = f + K1 * (1 - B + (B * len) / avgLen);
      score += idf(q) * ((f * (K1 + 1)) / denom);
    }
    return { id: d.id, kind: d.kind, score };
  });

  return scores
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
