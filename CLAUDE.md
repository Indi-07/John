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

## Architecture (one turn, top to bottom)

```
public/widget.html   Branded chat widget (SSE streaming)
   │ POST /chat  ·  /chat/stream
src/server.ts        Hono HTTP surface: validation, rate limit, CORS, static
src/pipeline.ts      route → gather approved facts → ground model → answer
   ├─ src/intent.ts     rule-based intent router (fast, deterministic)
   ├─ src/retrieval.ts  compact BM25 over approved Q&A + services (no deps)
   ├─ src/facts.ts      deterministic price/service formatting (verbatim)
   ├─ src/prompt.ts     system prompt + guardrails + hand-off text
   └─ src/llm.ts        LM Studio client (timeout, fallback, mock mode)
data/*.json          approved knowledge (services, prices, faq) — SEED/placeholder
tooling/ingest_xlsx.py   Python: approved Q&A xlsx → data/faq.json (offline)
scripts/*.ts         dev checks (smoke.ts, stream-test.ts)
src/types.ts         shared contract (ChatRequest/Response, Intent, Service…)
```

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

## Gotchas

- Background dev servers may be killed by some harnesses — run `npm run dev` in a
  normal terminal.
- The BM25 index and the scope line are built at load time from `data/` — restart
  after editing data.
