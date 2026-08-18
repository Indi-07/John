// Quick offline check of the answer path (run with LLM_MODE=mock).
// Not part of the build; run: LLM_MODE=mock npx tsx scripts/smoke.ts
import { answer } from "../src/pipeline.js";

const questions = [
  "how much is the category C course?",
  "which HGV licence do I need?",
  "do you do car lessons for my teenager?",
];

for (const q of questions) {
  const r = await answer(q);
  console.log("Q:", q);
  console.log("  intent:", r.intent, "| handoff:", r.handoff);
  console.log("  citations:", r.citations.map((c) => `${c.kind}:${c.id}`).join(", ") || "(none)");
  console.log("  answer:", r.answer);
  console.log("");
}
