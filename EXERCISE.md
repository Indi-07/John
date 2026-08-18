# Exercise brief — learn Claude Code on a real project

Welcome! This repo is a **working** proof-of-concept chatbot for NEDS (a UK HGV
training school). Your job isn't to admire it — it's to **use Claude Code to
understand it and extend it**. Build your own version.

> Everything runs in **mock mode with no LLM setup**, so you can start in two
> minutes. Wiring a real local model is an optional stretch goal.

## 0. Get it running (10 min)

```bash
npm install
cp .env.example .env      # LLM_MODE=mock is fine to start
npm run dev               # open http://localhost:8787/
```

Ask the widget a few questions. Then open Claude Code in this folder and try:

- "Explain how a single question flows from the widget to an answer."
- "Where do the prices come from, and how is the model stopped from inventing
  them?"

The goal of these is to practise letting Claude Code **read and explain a
codebase** — read `CLAUDE.md` first, it's the map.

## 1. Warm-ups (practise the core loop: branch → change → review)

Do each on its own git branch, then use `/code-review` before merging.

1. **Add a service.** NEDS wants to advertise **PCV (bus/coach) training**. Add
   it to `data/services.json` (+ a placeholder price) and confirm the bot answers
   questions about it. What else did you have to touch? (Hint: maybe nothing —
   that's the point of facts-outside-the-model.)
2. **Change the voice.** Make answers a little more energetic/North-East (see the
   NEDS brand — loud is on-brand). Edit `src/prompt.ts`; compare before/after.
3. **Tighten a guardrail.** Make the bot refuse to discuss anything about *car
   insurance* (out of scope). Prove it with a test question.

## 2. Build something (pick one, go deeper)

- **Eval harness.** Create `scripts/eval.ts` with ~15 real questions + expected
  behaviour (right price / correct decline / hand-off), and a pass/fail report.
  Use it to compare two prompts or two models objectively.
- **Better retrieval.** The current search is BM25 (`src/retrieval.ts`). Swap in
  embeddings (LM Studio serves an embedding model) behind the same interface and
  measure whether answers improve.
- **Lead capture.** Add an optional "request a callback" flow: collect name +
  phone/email, validate it, and log it to a local JSONL file (no CRM yet). Mind
  the plan's privacy rules — no sensitive data in chat.
- **Availability (stub → real).** Right now availability is deliberately faked.
  Design a `data/availability.json` read-model and have the bot suggest up to
  three options with a "subject to confirmation" caveat.

## 3. Stretch: go live on a local model

Install [LM Studio](https://lmstudio.ai), download a small model (e.g. a Qwen
4B), start its server, and set `.env` to `LLM_MODE=live` with your
`LLM_BASE_URL`/`LLM_MODEL`. Watch the answers get much more natural.

## How you'll be "graded" (on Claude Code skill, not the code)

- Did you use **branches + commits** with clear messages?
- Did you run **`/code-review`** and act on it?
- Did you keep **`CLAUDE.md`** updated when you changed the architecture?
- Did you let Claude Code do the reading/searching, and **verify** its work
  (typecheck, run it) rather than trusting blindly?

Have fun — break things on a branch, that's what they're for.
