# CLAUDE.md — project guide for Claude Code

This file gives Claude Code (and new humans) the context to work in this repo
productively. Keep it short and current.

## What this is

A small, self-hosted **public answer bot for NEDS** (North East Driving School,
the B2C arm of Chartwise UK). It answers a *narrow* set of questions about NEDS's
training services, grounded strictly in approved facts, and hands off to the
office when it can't. It is **not** an internal "company brain" — the knowledge
boundary is deliberately small. Full direction lives in
`self-hosted-implementation-plan.md`; this repo is the **Phase 1 local proof**.

This is also the **starter/teaching project** — see `EXERCISE.md`.

## Golden rules (the whole point of the design)

1. **Facts live outside the model.** Prices, services and Q&A come from
   `data/*.json`, read verbatim. The model *phrases* answers; it must never
   invent or alter a number, date, or service. If a fact isn't in the data, the
   bot doesn't state it.
2. **NEDS scope is fixed:** HGV C1 / C / C+E, B+E (car + trailer), Driver CPC,
   ADR, Forklift, Driver Medicals. It does **not** do learner car lessons. The
   scope line in `src/prompt.ts` is generated from `data/services.json`.
3. **Fail safe.** If the model is slow/unreachable, hand off to phone/email —
   never guess.
4. **Public-endpoint hygiene** (see the plan): no web/file access, message-length
   and rate limits, model/admin ports never exposed.
5. **No personal data, ever, not even for a callback.** The chat does not ask
   for, collect or store a name, phone number or email — this includes
   declining callback requests (see `CALLBACK_DECLINE_TEXT` in
   `src/prompt.ts`), not just refusing volunteered PII
   (`PERSONAL_INFO_TEXT`). Don't reintroduce a "leave your details" flow.
6. **Policy-sensitive replies are fixed text, not model output.** Car-lesson
   scope, personal info, callback declines, instructor-selection requests,
   greetings, and the unsure/irrelevant fallbacks all bypass the model
   entirely via `deterministicReply()` / the `SCOPE`-prefixed fact-block
   pattern in `src/pipeline.ts`. Add new hard policies the same way rather
   than trusting the system prompt alone — see `SESSION-NOTES-2026-08-18.md`
   for why (a live/mock model can't be relied on to always ask for the
   details it's told not to ask for).

## Architecture (one turn, top to bottom)

```
public/widget.html   Branded chat widget (SSE streaming, minimize/resize/font-size controls)
   │ POST /chat  ·  /chat/stream   (both take an optional sessionId)
src/server.ts        Hono HTTP surface: validation, rate limit, CORS, static
src/pipeline.ts      deterministic bypasses → route → gather approved facts → ground model → answer
   ├─ src/intent.ts     rule-based intent router + guardrail detectors (fast, deterministic)
   ├─ src/retrieval.ts  compact BM25 over approved Q&A + services (no deps)
   ├─ src/facts.ts      deterministic price/service formatting (verbatim)
   ├─ src/prompt.ts     system prompt + all fixed guardrail/fallback texts
   ├─ src/session.ts    in-memory per-session pending-pricing-offer state (TTL'd)
   └─ src/llm.ts        LM Studio client (timeout, fallback, mock mode)
data/*.json          approved knowledge (services, prices, faq) — SEED/placeholder
tooling/ingest_xlsx.py   Python: approved Q&A xlsx → data/faq.json (offline)
scripts/*.ts         dev checks (smoke.ts, stream-test.ts)
src/types.ts         shared contract (ChatRequest/Response, Intent, Service…)
```

`src/pipeline.ts`'s `ground()` handles routing AND the `SCOPE`-prefixed
fixed-text short-circuits (greeting, car-lessons, broad "what do you offer"
list). Separately, `deterministicReply()` handles checks that must run
*before* grounding and never reach the model at all (personal info, callback
requests, instructor selection) — see the golden rule above for why that
split exists. `resolveAffirmative()` handles a short "yes"-shaped reply
against `src/session.ts`'s pending-offer state.

**Stack split (deliberate):** the *service* is TypeScript (shared types with the
widget; native fit for Supabase/n8n/Cloudflare later). Python is for *offline
tooling only* (xlsx ingest, future embeddings/eval). The two never share a
runtime — they communicate through data files.

## Run it

```bash
npm install
npm run dev            # http://localhost:8787/
```

- Out of the box it runs in **mock mode** if you haven't set up a model — copy
  `.env.example` to `.env` and set `LLM_MODE=mock` to be sure. Mock returns a
  templated grounded answer so the whole pipeline works with no LLM.
- For **live** answers, run LM Studio (or any OpenAI-compatible server), then in
  `.env`: `LLM_BASE_URL=http://<host>:1234/v1`, `LLM_MODEL=<id>`, `LLM_MODE=live`.
- `npm run typecheck` before considering a change done.
- Quick behaviour check: `npx tsx scripts/smoke.ts` (add `LLM_MODE=mock` to skip
  the model).

## Conventions

- TypeScript, ESM, `strict`. Config is read once in `src/config.ts` — don't reach
  for `process.env` elsewhere.
- Keep the answer path non-throwing: failures become a hand-off, not a 500.
- All `data/*.json` here is **placeholder seed data**, clearly marked. Real
  prices/Q&A replace it (Phase 0) — never treat the seed as approved facts.
- `.env` is gitignored. Never commit secrets or a real endpoint.
- **`data/faq.json` is generated — never hand-edit it.** It's produced from
  `../NEDS-chatbot-question-bank-3.xlsx` by `tooling/ingest_xlsx.py`, which
  trusts a row if it's office-reviewed (`PK Reviewed`/`Ad Reviewed`) OR has
  `High`/`Medium` research confidence, and always drops `DELETE`/`Not
  Relevant` rows regardless of confidence. To correct an answer's wording,
  edit the source xlsx's `Draft chatbot answer` cell (back it up first —
  `cp` a `.bak` copy; openpyxl re-saves change the file's byte layout even
  for a one-cell edit) and re-run the ingest script — that keeps the
  correction durable across future re-ingests instead of being silently
  overwritten.
- Each service in `data/services.json` needs both `definition` (a plain,
  generic explanation — no NEDS branding, no "we offer") and `summary` (the
  NEDS-offering description). `service_query`/"what is X" answers lead with
  `definition`; don't collapse the two fields back into one.

## Gotchas

- Background dev servers may be killed by some harnesses — run `npm run dev` in a
  normal terminal.
- The BM25 index and the scope line are built at load time from `data/` — restart
  after editing data.
- When building FAQ facts/citations, always walk `search()`'s ranked `hits`,
  never the raw `faqs` array — iterating `faqs` orders by spreadsheet ID, not
  relevance, so a same-topic-but-wrong FAQ (lower ID) can silently outrank
  the actual best match in whatever gets shown first.
- `src/retrieval.ts`'s `STOP` list matters more than it looks: a common word
  missing from it (e.g. "about" was, until this session) gets an inflated
  BM25 weight from being rare across this specific corpus, which can make
  unrelated messages score just high enough to dodge the
  unsure/irrelevant-detection threshold.
- A message that both names a specific service *and* implies a different
  intent (e.g. "How do I sign up for HGV training?") currently loses to the
  literal service-name match and gets routed as a service/price answer, not
  the more specific FAQ. Known, not yet fixed — see
  `SESSION-NOTES-2026-08-18.md`.
