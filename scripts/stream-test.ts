// Verify the live streaming path the widget uses. Run: npx tsx scripts/stream-test.ts
import { answerStream } from "../src/pipeline.js";

const q = "do you do forklift training and how much is it?";
console.log("Q:", q, "\nStreaming:\n");
let full = "";
for await (const delta of answerStream(q, (m) => console.log("[meta]", m.intent, m.citations.map((c) => c.id).join(",")))) {
  process.stdout.write(delta);
  full += delta;
}
console.log("\n\n--- complete (", full.length, "chars) ---");
