// Flesch-Kincaid Grade Level: a well-known reading-level formula —
// 0.39 * (words/sentence) + 11.8 * (syllables/word) - 15.59. Used only as a
// dev-time check (see scripts/checkReadingLevel.ts) — never a runtime gate,
// since the answer pipeline must stay non-throwing per CLAUDE.md's golden
// rules, and this project's established pattern is verifying live/mock
// output by hand or via scripts/smoke.ts, not blocking the answer path on a
// heuristic.
//
// Syllable counting here is an approximation (there's no exact algorithm
// short of a full pronouncing dictionary) — good enough to flag "this reads
// dense" during development, not precise to the decimal.

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  // Strip a silent trailing e/es/ed and a leading y (doesn't start a new
  // vowel sound) before counting vowel groups — the standard adjustment
  // used by lightweight syllable-count heuristics.
  const trimmed = w.replace(/(?:e|es|ed)$/, "").replace(/^y/, "");
  const vowelGroups = trimmed.match(/[aeiouy]+/g);
  return Math.max(1, vowelGroups ? vowelGroups.length : 1);
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+(?:\s+|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitWords(text: string): string[] {
  return text.match(/[A-Za-z']+/g) ?? [];
}

// Returns the Flesch-Kincaid grade level for `text` (e.g. 9.2 ≈ a US grade
// 9 reader). Returns 0 for text with no sentences/words rather than NaN, so
// a caller can print/compare the result without a special case.
export function fleschKincaidGrade(text: string): number {
  const sentences = splitSentences(text);
  const words = splitWords(text);
  if (!sentences.length || !words.length) return 0;

  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const grade = 0.39 * (words.length / sentences.length) + 11.8 * (syllables / words.length) - 15.59;
  return Math.round(grade * 10) / 10;
}
