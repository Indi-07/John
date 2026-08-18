# NEDS chat — self-hosted PoC

A small, fast, self-hosted answer bot for the public NEDS
(nedrivingschool.co.uk) side of Chartwise UK. It answers a narrow set of NEDS
questions from **approved facts kept outside the model**, and hands off to the
office when it can't. See `self-hosted-implementation-plan.md` for the full
production direction; this repo is the **Phase 1 local proof**.

## What this PoC does today

- Classifies each message into a small intent set (price / service / FAQ /
  availability / lead / out-of-scope), plus a set of deterministic
  policy/safety guardrails checked ahead of routing (see below).
- Answers **prices and services deterministically** from `data/*.json` — the
  model may quote these numbers but never invents or alters them. A plain
  "what is X" question answers from a separate `definition` fact before
  connecting it to what NEDS offers; price is withheld unless it's what was
  actually asked (information pacing).
- Retrieves relevant approved Q&A with an in-process BM25 index (no GPU, no
  external service) — 409 approved entries as of 2026-08-18, ingested from
  the real NEDS Q&A spreadsheet (see "Updating the knowledge" below).
- Uses a **local LLM on the Mac Studio** (LM Studio, OpenAI-compatible) only to
  phrase the answer in NEDS's voice, ≤120 words, or to hand off.
- Falls back to a phone/email hand-off if the model is slow or unreachable.
- Remembers, per session, whether it just offered to give pricing — so a
  short "yes please" reply is answered directly instead of being routed as a
  fresh, unrelated question (`src/session.ts`, in-memory, 10-minute TTL).
- Hard, model-bypassing declines for: personal information volunteered
  (name/DOB/licence number/email/phone), callback/contact-detail requests
  (the chat **never** collects these, even to arrange a callback),
  instructor-selection requests (by gender, age, race/ethnicity or any other
  characteristic), and out-of-scope car-lesson questions.
- Serves a NEDS-branded demo widget with token streaming, a minimize toggle,
  drag-to-resize, and text-size controls.

**Not in this PoC** (deferred to later phases, by design): live training
availability, CRM/lead writes, n8n, Supabase, the Cloudflare public endpoint and
its security review. The seams for all of these are stubbed cleanly.

> ⚠️ All prices/services/Q&A in `data/` are **placeholder seed data**, clearly
> marked. They are replaced with the approved catalogue (Phase 0) before any
> pilot.

See `SESSION-NOTES-2026-08-18.md` for a detailed log of what changed and why.

## Architecture

```
public/widget.html   NEDS-branded chat widget (streaming, minimize/resize/font-size)
        │ POST /chat  ·  /chat/stream (SSE) — both take an optional sessionId
src/server.ts         Hono HTTP surface: validation, rate limit, CORS
src/pipeline.ts       one turn: deterministic bypasses → route → gather facts → ground model → answer
  ├─ src/intent.ts    rule-based intent router + guardrail detectors (fast, deterministic)
  ├─ src/retrieval.ts compact BM25 over approved Q&A + services
  ├─ src/facts.ts     deterministic price/service formatting (verbatim)
  ├─ src/prompt.ts    system prompt + all fixed guardrail/fallback texts
  ├─ src/session.ts   in-memory per-session pending-pricing-offer state
  └─ src/llm.ts       LM Studio client (timeout, fallback, mock mode)
data/*.json           approved knowledge (facts outside the model)
tooling/ingest_xlsx.py  Python: approved xlsx Q&A → data/faq.json (offline)
```

Language split (decided 2026-08-18): **TypeScript service** (shared types with
the widget; native fit for Supabase / n8n / Cloudflare later) + **Python for
offline tooling only** (xlsx ingest, future embeddings/eval). The two never
share a runtime — they communicate through data files / the DB.

## Run it

```bash
npm install
cp .env.example .env      # then edit .env

# Preview without the model (templated grounded answers):
LLM_MODE=mock npm run dev

# Live, against LM Studio on the Mac Studio:
#   1. On the Studio: start LM Studio, load a model, enable the local server.
#   2. Put the Studio's Tailscale address in .env:
#        LLM_BASE_URL=http://<studio-tailscale-ip>:1234/v1
#        LLM_MODEL=<the model id LM Studio reports>
#        LLM_MODE=live
npm run dev
```

Open <http://localhost:8787/> for the widget. Health: `GET /health`.

## Updating the knowledge

```bash
python3 -m venv tooling/.venv
tooling/.venv/bin/pip install -r tooling/requirements.txt
tooling/.venv/bin/python tooling/ingest_xlsx.py path/to/neds-qa.xlsx
```

`data/faq.json` is **generated** — never hand-edit it. The script trusts a
row if it's office-reviewed (`Office-approved answer` = `PK Reviewed` or `Ad
Reviewed`) OR has `High`/`Medium` research confidence, and always drops
`DELETE`/`Not Relevant` rows regardless of confidence. To correct an answer's
wording, edit the *source* xlsx's `Draft chatbot answer` cell (keep a backup
copy first) and re-run the ingest — a direct edit to `data/faq.json` will be
silently overwritten next time someone re-runs it.

Prices and services are edited directly in `data/prices.json` /
`data/services.json` for now (these become Supabase reads in production).
Each service needs both a `definition` (plain, generic explanation, no NEDS
branding) and a `summary` (the NEDS-offering description) — they serve
different parts of the answer, don't merge them back into one field.

## Config (`.env`)

| Var | Meaning |
|---|---|
| `PORT` | HTTP port (default 8787) |
| `LLM_BASE_URL` | LM Studio OpenAI endpoint (Studio Tailscale IP) |
| `LLM_MODEL` | Model id LM Studio reports |
| `LLM_TIMEOUT_MS` | Hard timeout before hand-off (default 8000) |
| `LLM_MODE` | `live` calls the model; `mock` templates a grounded reply |
| `MAX_MESSAGE_CHARS` | Public message length cap (default 600) |
| `MAX_ANSWER_WORDS` | Target answer length ceiling (default 120) |
