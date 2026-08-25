// Dev-time reading-level check for the grade-9 ceiling in src/prompt.ts's
// rule 38. NOT part of the build and never a runtime gate — the answer
// pipeline stays non-throwing per CLAUDE.md's golden rules, and this
// project's established pattern is verifying live/mock output by hand or
// via a script like this one, not blocking the answer path on a heuristic.
// Prints a warning (never fails/exits non-zero) for anything scoring above
// grade 9, so it's visible during development without breaking CI/dev runs.
//
// Run: LLM_MODE=mock npx tsx scripts/checkReadingLevel.ts
import { answer } from "../src/pipeline.js";
import { referenceDocSectionBodies } from "../src/llm.js";
import { courseComparisonMd, coursesByJobMd } from "../src/knowledge.js";
import { fleschKincaidGrade } from "../src/readingLevel.js";

const GRADE_CEILING = 9;

function report(label: string, grade: number, sample: string) {
  const flag = grade > GRADE_CEILING ? " *** ABOVE GRADE 9 ***" : "";
  console.log(`  [grade ${grade.toFixed(1)}]${flag} ${label}`);
  if (flag) console.log(`    "${sample.slice(0, 160)}${sample.length > 160 ? "…" : ""}"`);
}

console.log("--- (a) representative answers, via the real answer pipeline ---");
const questions = [
  "whats the difference between c and c1",
  "what is Driver CPC?",
  "can you tell me about c+e?",
  "how much is category C1 training?",
  "what qualifications do I need to become an ambulance driver?",
  "what are the differences between all your HGV courses?",
];
for (const q of questions) {
  const r = await answer(q);
  report(q, fleschKincaidGrade(r.answer), r.answer);
}

console.log("\n--- (b) reference doc sections, as consumed (pre-humanize) by humanizeReferenceSection() ---");
for (const [docLabel, doc] of [
  ["course-comparison.md", courseComparisonMd],
  ["courses-by-job.md", coursesByJobMd],
] as const) {
  for (const body of referenceDocSectionBodies(doc)) {
    const preview = body.replace(/\s+/g, " ").slice(0, 50);
    report(`${docLabel} — "${preview}…"`, fleschKincaidGrade(body), body);
  }
}
