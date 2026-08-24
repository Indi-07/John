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
   **Flag for confirmation:** John's 2026-08-18 sign-off (see above) named
   only those 8, but `data/faq.json` carries 7 well-reviewed FAQs (406–412)
   describing OLAT (Operator Licence Awareness Training) as a real, current
   NEDS offering — one/two-day courses, classroom/online/nationwide
   delivery. Before that gap was closed, this caused a live contradiction:
   asked directly ("Do you offer OLAT?") the bot correctly said yes, grounded
   on FAQ 410; asked a generic "not sure what training I need" question, it
   sometimes said NEDS doesn't offer OLAT, because the hard "ONLY these
   services" scope rule (correctly) overrode weaker retrieval once OLAT
   wasn't in the confirmed list. Added as a 9th service (`id: "olat"`,
   `data/services.json`) to stop the contradiction, but this needs an actual
   confirm-or-remove decision from NEDS, not just this inference from FAQ
   content — there's no reviewed price data for it (`NEDS-prices.csv` never
   covered it), so a price question about it still correctly hands off
   rather than guessing.
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
public/widget.html   Branded chat widget (SSE streaming, minimize/resize/font-size controls,
                     inline price calculator — see "Price calculator" below)
   │ POST /chat  ·  /chat/stream   (both take an optional sessionId)
   │ GET /catalogue   (services + prices, feeds the widget's price calculator)
src/server.ts        Hono HTTP surface: validation, rate limit, CORS, static
src/pipeline.ts      deterministic bypasses → route → gather approved facts → ground model → answer
   ├─ src/intent.ts     rule-based intent router + guardrail detectors (fast, deterministic)
   ├─ src/retrieval.ts  compact BM25 over approved Q&A + services (no deps)
   ├─ src/facts.ts      deterministic price/service formatting (verbatim)
   ├─ src/prompt.ts     system prompt + all fixed guardrail/fallback texts
   ├─ src/session.ts    in-memory per-session pending-offer + last-topic state (TTL'd)
   └─ src/llm.ts        LM Studio client (timeout, fallback, mock mode)
data/faq.json, data/prices.json   real, reviewed data — see their generated-data notes below
data/services.json    service LIST confirmed; definition/summary prose still placeholder
tooling/ingest_xlsx.py   Python: approved Q&A xlsx → data/faq.json (offline)
tooling/ingest_prices_csv.py  Python: reviewed pricing CSV → data/prices.json (offline)
scripts/*.ts         dev checks (smoke.ts, stream-test.ts)
src/types.ts         shared contract (ChatRequest/Response, Intent, Service…)
```

### Price calculator

`public/widget.html`'s "Calculate my course cost" chip (shown alongside the
usual suggestion chips whenever the intent is `price_query` or
`service_query`) opens an inline card, fed by `GET /catalogue` — the exact
same `services`/`prices` arrays the chat itself answers from, never a
separate copy. Course selection lists every service with at least one price
entry; picking one then either shows the single price directly, offers a
plain dropdown of that service's price options, or — for forklift
specifically — a two-step "experience level" × "group size" picker.

That tier/size picker is **parsed from the approved price labels**
(`FORKLIFT_RE` in the widget's script, matching `"Beginner — 2 people, ..."`
-style labels), not a hand-coded rate table — it can only ever offer
combinations that actually exist in `data/prices.json`, and never needs
updating in step with a price change there. A couple of forklift price
entries that don't fit that shape (the "from" headline, the qualification
card) are simply left out of the picker rather than blocking it — see the
`renderVariables()` comment. If another service ever needs its own
structured picker (not just a flat list of options), follow the same
pattern: parse it from the real labels, don't invent a formula.

### Prerequisite clarification (`PREREQUISITE_NOTES` in `src/facts.ts`)

When explaining a course that needs another qualification first (C+E needs
Category C; B+E and C+E Direct need an ordinary car licence; ADR needs the
relevant HGV licence; Driver CPC periodic needs Initial CPC for a first-time
holder), the answer must say BY NAME whether NEDS also offers that
prerequisite — not just describe it and leave the visitor to infer. This
went through three attempts before it was reliable, worth knowing before
trying to "fix" it again the same way:
1. A general prompt rule ("check the prerequisite against NEDS's scope and
   say so") — the model had to both recall the prerequisite and cross-check
   it against the scope line itself, and dropped the clause roughly half the
   time across repeated identical queries.
2. A concrete per-course mapping baked into the rule text (exact sentences
   for C+E/B+E/ADR/CPC) — no more reliable; if anything, slightly worse,
   and once even lost rule 5's definition-first ordering entirely.
3. **What worked**: moved it out of the prompt-reasoning layer entirely —
   `serviceFactsOnly()` now appends a `PREREQUISITE` fact line (whether the
   prerequisite is offered, by name) for the services that have one, the
   same "outside the model, just relay it" treatment as every other fact.
   Only reliable once the line was ALSO marked "(must be mentioned in your
   answer, not just used as background)" — without that framing, a plain
   `PREREQUISITE ...` fact sitting alongside a `DEFINITION`/`SERVICE` line
   still got treated as optional background rather than something to
   surface. Even with this, expect occasional softer phrasing under live
   model sampling (verified ~4/4 consistent for C+E, ~1/2 fully explicit
   for B+E and ADR in one test run) — not perfectly deterministic, but far
   more reliable than either prompt-only attempt.

**Reconciling prerequisites with previously discussed packages** (rule 35 in
`src/prompt.ts`, plus an extra sentence on the `hgv-ce` and `driver-cpc`
entries in `PREREQUISITE_NOTES`): NEDS sells a combined 7-day Category C plus
C+E package (`ce-2` in `data/prices.json`) that already includes the
Category C days, and its all-in price also includes gaining Initial CPC. If
a visitor already discussed that combined package (or Category C training)
earlier in the conversation, the C+E prerequisite must not be restated as
something to arrange separately — the model should recognise it's already
covered and say so. This can't be a static fact on its own (it depends on
what was actually discussed), so it's handled as a system-prompt rule that
tells the model to check the `RECENT VISITOR MESSAGES` / `TOPICS DISCUSSED
SO FAR` context before restating a `PREREQUISITE` line, combined with
updating the `PREREQUISITE_NOTES` text itself to mention the combined
package exists (so the model has something concrete to recognise). Verified
live: discussing the combined package, then asking "Tell me about C+E",
correctly folds in "we also run a combined 7-day Category C plus C+E
package that already includes the Category C days" rather than repeating
the standalone prerequisite as if it still applied.

**Distinguishing initial vs periodic Driver CPC** (rule 36): periodic Driver
CPC (35 hours, renewed every 5 years) only applies to people who already
hold Driver CPC and work as professional drivers — it is never a
prerequisite for a first HGV course. The `driver-cpc` entry in
`PREREQUISITE_NOTES` was reworded to spell out that distinction explicitly,
and rule 36 in `src/prompt.ts` backs it up as a standing guardrail (covering
services that have no `PREREQUISITE` fact at all, like `hgv-c`, since this
is a "never fabricate this claim" rule, not something that only fires when
a specific fact is present). Verified live: "Do I need Driver CPC before I
can start my Category C training?" correctly answers "You don't need to
hold a Driver CPC before you start... Initial CPC is included... the
35-hour periodic renewal only applies once you're already working as a
professional driver."

**Course duration accuracy** (rule 37): durations must come from the
approved facts (a price package's own label, e.g. "5-day training
package"), never be calculated or inferred from a different course's
duration. Note: `data/faq.json` has two FAQs about C+E duration that are
easy to blend incorrectly — FAQ 96 ("standard C+E training", ~1 week
practical) and FAQ 97 ("C+E Direct", a *different* named product, 7 days
practical + 6–10 weeks overall including DVLA/theory scheduling). Retrieval
can surface both for a plain "how long does the C+E course take" question,
and a live-model answer was observed blending them into one narrative
without clearly flagging they're different course variants. Rule 37 doesn't
fully prevent this on its own since the durations involved are real (not
invented) — it's rule 23 (don't blend two plausibly-overlapping FAQs)
that's actually responsible for keeping these apart, so if this resurfaces,
that's the rule to strengthen rather than rule 37.

### Course comparison

`data/course-comparison.md` (copied verbatim from
`../neds-courses-comparison.md`, one level above this repo) is a well-sourced
comparison of all nine services — similarities, differences, and the four
natural groups they fall into. Unlike `data/faq.json`/`data/prices.json`,
it's general UK HGV/PCV licensing fact with external citations (gov.uk,
DVSA, CILT(UK), etc.), not NEDS-specific pricing/policy — so it doesn't go
through the FAQ/price ingest-and-review process those do, and there's no
`ingest_*.py` for it since it needs no transformation. `src/knowledge.ts`
loads it into `courseComparisonMd`; `src/intent.ts`'s
`isCourseComparisonQuery` (phrases like "difference between," "compare,"
"vs") routes to it in `pipeline.ts`'s `ground()`, ahead of ordinary
retrieval — retrieval finds one best-matching fact, not a real comparison
across several, so it can't answer this shape of question well on its own.
System prompt rule 32 keeps the model answering the specific comparison
asked (e.g. just C1 vs C) rather than dumping the whole nine-course
reference every time.

### Courses by job

`data/courses-by-job.md` (same provenance/treatment as the comparison doc
above, copied from `../neds-courses-by-job.md`) is a job-/situation-led
guide to the same nine services — organised by qualification, but it
answers "what do I need for job X" and "what can I do with qualification Y"
symmetrically, since both are the same underlying mapping read either
direction. `coursesByJobMd` in `knowledge.ts`; `isJobQualificationQuery` in
`intent.ts` (phrases like "what job," "what can I do with," "what do I need
to become") routes to it in `ground()`, same slot as the comparison doc.
Rule 33 keeps answers scoped to the relevant job/qualification rather than
the whole guide, and — per rule 25 — says so honestly rather than forcing a
match when the visitor's situation genuinely isn't covered (e.g. a taxi
driver asking what they need, which isn't in NEDS's HGV-focused scope at
all).

### Course images

`public/assets/courses/` holds real NEDS training-vehicle photos, extracted
from the client-provided "Courses and images.pdf" (not stock/placeholder —
treat them the same as any other approved asset). Only 4 of the 9 services
have one (`COURSE_IMAGES` in the widget's script: `hgv-c1`, `hgv-c`,
`hgv-ce`, `driver-cpc`) — the PDF simply doesn't cover B+E, ADR, forklift,
medicals or OLAT, and a service with no entry just gets no image, never a
wrong or generic stand-in. The C1 image is a Yorkshire Ambulance Service
ambulance, not a NEDS vehicle — that's the pairing the source PDF itself
uses (ambulances commonly sit in the 3.5–7.5t C1 weight class), kept as
provided rather than second-guessed; flagged once as possibly surprising,
not yet asked to be swapped.

The widget shows the image (above the reply, in a shared-width
`.course-card` with the message bubble — see the `buildCourseCard` comment)
only when the response cites **exactly one** service; a broad "what do you
offer" answer or any multi-service reply gets none. It's attached on the
first streamed token, not the `meta` event that precedes it, so the image
appears exactly when the reply's text starts rather than while the model is
still "typing…".

**Repeat avoidance**: `buildCourseCard` also tracks, per page load
(`shownImages`, a `serviceId → {turn, movedAway}` map — resets on reload,
same as `sessionId`), whether a course's image has already been shown this
conversation, and suppresses it (text only) on a repeat UNLESS the visitor's
message reads as an explicit re-request ("show"/"see" + "picture"/"photo"/
"image"/"pic"), or the topic has both moved away since AND at least 5
ask()-turns have passed since it last actually rendered. That "moved away"
flag is updated on every turn, not just ones that show an image, so a run
of unrelated questions still counts as leaving the topic; the 5-turn gap is
measured from when the image last actually rendered, not from every time
the course was merely mentioned while suppressed.

If the source PDF is ever updated with more course photos, re-extract with
`pdftoppm`/`fitz` (`pip install pymupdf`, `doc.extract_image(xref)` per
page) rather than screenshotting — the embedded originals are full quality,
no re-compression needed at the sizes used here (700×500, ~50KB).

### Multi-word keyword matching (`keywordHit` in `src/intent.ts`)

Matches are word-bounded on **both** ends, not a plain substring — this bit
a real query: `hgv-c`'s keyword `"category c"` used to also match inside
`"category c1"` and `"category c+e"` (plain `.includes()`), so a C1 or C+E
price question wrongly cited BOTH `hgv-c1`/`hgv-ce` and `hgv-c`, dragging in
Category C's full price list alongside the one actually asked about — same
failure shape as the "office"/"about" gotchas elsewhere in this file. `\b`
alone blocks the digit case (`c` and `1` are both word characters, so no
boundary exists between them) but NOT `+` (a non-word character, so `\b`
sees a boundary there anyway) — hence the extra `(?!\+)` after the boundary.
Re-run this check if a new keyword is added that could be a prefix of
another service's keyword.

`src/pipeline.ts`'s `ground()` handles routing AND the `SCOPE`-prefixed
fixed-text short-circuits (greeting, car-lessons, broad "what do you offer"
list). Separately, `deterministicReply()` handles checks that must run
*before* grounding and never reach the model at all (personal info, callback
requests, instructor selection) — see the golden rule above for why that
split exists. `resolveAffirmative()` handles a short "yes"-shaped reply
against `src/session.ts`'s pending-offer state. Separately, `ground()` also
falls back to `src/session.ts`'s last-topic state when a reply names no
course of its own (e.g. answering a clarifying question about group size) —
see the "Staying on topic through follow-up answers" comment there; a reply
that does name a different service always overrides it.

Separately again: each model turn is system prompt + ONE user message —
deliberately no chat history — so anything a visitor volunteers in one turn
(e.g. "I'm a complete beginner, just me") is otherwise invisible on a later,
differently-worded turn ("how much is forklift training?"). `src/session.ts`'s
`getRecentMessages`/`recordMessage` (a short rolling window, verbatim) fixes
this at the session-state level rather than by prompting harder — see
`buildUserTurn` in `src/prompt.ts` for how it's threaded into the next turn's
facts as a clearly-labelled "context, not fact" section, and rule 22 in the
system prompt for how the model is told to use it. Never call `recordMessage`
with a message `containsPersonalInfo` has already flagged — that message is
declined before grounding (golden rule 5) and must not resurface into a
later prompt either.

A third, separate piece of session state — `getDiscussedTopics`/
`recordDiscussedTopics` — is the WHOLE session's distinct services touched
on so far, deduped, in first-mentioned order; unlike `getLastTopic` (single
most recent, overwritten every turn) or `getRecentMessages` (3-message
window), this one only grows. It powers rule 27's "progress recap" (e.g.
medical, then CPC, then asking about practical training → "so far we've
covered X and Y, next step Z") — threaded into `buildUserTurn` as service
NAMES (via `serviceById`), only once there are 2+, so a single-topic
conversation never carries the block at all.

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
- `data/faq.json` and `data/prices.json` are **real, reviewed data** — see
  their generated-data notes below. `data/services.json`'s service *list* is
  confirmed (John, 2026-08-18); its `definition`/`summary` prose is still
  illustrative placeholder wording pending Phase 0 sign-off — check its own
  `_note` before treating any field as approved.
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
- **`data/prices.json` is generated — never hand-edit it.** It's produced
  from `../NEDS-prices.csv` (the reconciled, row-by-row reviewed pricing
  sheet — every row is either John-approved as shown or approved with a
  specific amend) by `tooling/ingest_prices_csv.py`. `amountGBP` is always
  the **Inc VAT** price for the item exactly as its own label describes it —
  deliberately *not* the sheet's separate "All-in / package" figure, which
  is usually a different, larger bundle (e.g. + medical + theory tests) than
  the plain item in that row; quoting it under that row's label would
  misstate what it buys. That bundle price is preserved in the row's own
  `note` instead. A handful of rows needed a judgment call beyond a
  mechanical column mapping (a stale internal "CHECK"/"Confirm" comment to
  strip, or John's literal override text to apply) — those live in the
  script's `ROW_OVERRIDES` table, not as text-stripping heuristics. To
  correct a price, edit the source CSV and re-run the ingest script.
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
- Retrieval will happily match a word in the visitor's message against the
  *same word* in an unrelated course/FAQ — e.g. "how do I contact the
  office" was matching the "transport-office awareness training" course on
  "office" alone. When a phrasing pattern is safety/policy-sensitive (asking
  how to reach NEDS, asking the bot to contact NEDS on the visitor's behalf,
  etc.), give it its own deterministic detector in `src/intent.ts` rather
  than trusting retrieval to disambiguate intent from a single shared word.
- A message that both names a specific service *and* implies a different
  intent (e.g. "How do I sign up for HGV training?") currently loses to the
  literal service-name match and gets routed as a service/price answer, not
  the more specific FAQ. Known, not yet fixed — see
  `SESSION-NOTES-2026-08-18.md`.
- `src/llm.ts`'s mock-mode price parsing pulls the "£amount unit" headline
  out of a formatted `PRICE` line by slicing from the first `£`, not by
  splitting the whole line on `" — "` — real price labels can themselves
  contain `" — "` (e.g. "Beginner — 1 person, 3 days"), and splitting from
  the start used to cut the line off before the amount ever appeared.
- `src/intent.ts`'s `AVAILABILITY_HINTS` matters more than it looks, the same
  way `retrieval.ts`'s `STOP` list does: a scheduling-sounding question that
  doesn't match it (e.g. "Is there a course starting soon?" — no "when," no
  "available," no "dates") never gets routed to `training_availability_query`
  and never reaches the deterministic "no live dates" fact, so it falls
  through to weak FAQ retrieval instead — and the model, left ungrounded,
  filled the gap with plausible-sounding scheduling filler ("we have a few
  courses starting soon") that wasn't backed by anything. Same failure shape
  as the "office" and "about" gotchas above: a routing/retrieval gap that
  reads as a hallucination but is actually a missing keyword. If a new
  scheduling phrasing produces a confident-sounding but ungrounded answer,
  add it to `AVAILABILITY_HINTS` rather than only tightening the prompt.
- **Auditing for new keyword collisions** (the "office" gotcha above is one
  instance of a general risk class, worth re-checking after any large
  `data/faq.json` re-ingest): find candidate pairs with a Python pass over
  the FAQ corpus — tokenize each `question + answer`, keep words that appear
  in the QUESTION of at least one FAQ and in exactly 2 FAQs corpus-wide
  overall (BM25 weights rare words heavily, which is exactly what made
  "office" and "about" misfire), then drop pairs whose `keywords` arrays
  already overlap (same category, not a cross-topic collision). Read the
  survivors by eye — most are generic connector words a stricter stopword
  list would exclude; a real one reads like a homograph or a name collision
  (e.g. "refuse" as in a refuse lorry vs. "refuse" as in decline entry).
  Confirm any real candidate against the LIVE server (`curl .../chat`) with a
  realistic visitor phrasing before treating it as a bug — this session
  tried several plausible-looking candidates this way (refuse-vehicle vs.
  refuse-entry, "heavy" C1 weight vs. "heavy goods" medical eligibility, two
  separate "eligibility" pairs, "free" parking vs. a free ADR download) and
  none actually misfired: BM25's multi-word scoring correctly separated all
  of them once other signal words were accounted for, unlike "office" and
  "about," which had almost no other overlapping context to fall back on.
  When one genuinely does misfire, fix it at this level (a stopword, a
  deterministic detector in `src/intent.ts`) rather than only asking the
  model to guess right despite bad retrieval input — see rule 23 in
  `src/prompt.ts` for the model-side half of this (prefer the FAQ that
  actually answers the question over the one that merely shares a word),
  which only ever compensates for good-but-imperfect retrieval, not a
  genuine data-level collision.
