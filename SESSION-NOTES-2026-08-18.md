# Session notes — 2026-08-18

Working session on the NEDS chat Phase 1 PoC (`Indi-07/John` on GitHub). Started
from the freshly-cloned repo with only placeholder seed data and no model
running; ended with 409 approved Q&A entries, a full set of deterministic
safety/policy guardrails, a rewritten answer-style system prompt, basic
conversation memory, and several widget UI additions. All changes are
committed locally (`873419a`); push to GitHub was pending GitHub
authentication in this environment as of the end of this session.

## Environment setup

- No Node.js or Homebrew present. Installed `nvm`, then Node v24.19.0 (LTS) —
  user-space, no admin rights needed.
- Ran the PoC in `LLM_MODE=mock` throughout (no LM Studio instance available
  in this environment) — mock mode templates a grounded reply without calling
  a model, so the whole pipeline could be exercised and demoed end-to-end.
- Installed `openpyxl` in a `tooling/.venv` to run the xlsx ingest script.

## Knowledge base ingestion (`tooling/ingest_xlsx.py`)

- Rewrote the ingest script to match the real shape of
  `NEDS-chatbot-question-bank-3.xlsx` (header row 6 of the "Q&A Bank" sheet;
  the original script assumed a generic `question`/`answer` header).
- Trust rule, arrived at in two steps:
  1. First pass: only rows with `Office-approved answer` exactly `PK
     Reviewed` or `Ad Reviewed` (42 entries).
  2. Widened on request to also include rows with `Confidence` = `High` or
     `Medium`, while `DELETE`/`Not Relevant` rows are **always** excluded
     even if their confidence is high (one row — a stale "£1 ADR" promo —
     hit exactly that case). Final count: 409 entries, up from 504 total
     questions in the bank (17 delete/not-relevant, remainder unreviewed).
- Fixed a real ordering bug in `src/pipeline.ts`: FAQ facts were being built
  by walking the FAQ list in spreadsheet-ID order rather than by retrieval
  score, so a lower-scoring but lower-ID FAQ could win over the actual best
  match (surfaced when "What happens if I fail the Category D test?" was
  initially answering with the *Category C* test's FAQ text instead).
- Corrected several FAQ answers by direct instruction, always by editing the
  source spreadsheet (with a timestamped backup first) and re-running the
  ingest — never hand-editing the generated `data/faq.json`:
  - C+E Direct duration (ID 97) and Category D retest (ID 122) — reworded
    for a warmer, more reassuring tone.
  - "How do I book a course?" (ID 289) — replaced a five-channel list with a
    simpler primary-path/fallback structure, and added "sign up" wording so
    it's actually retrievable for that phrasing (its old text only said
    "book", so a literal "sign up" query didn't match at all).
  - Added a new FAQ (ID 505), "How can I contact you?" — didn't exist in the
    bank at all. Had to give it the same category as its sibling
    contact-related FAQs so it inherits the right BM25 keyword weighting;
    its own question text reduces to just the single word "contact" once
    stopwords are stripped, so it wasn't beating its siblings for its own
    literal wording otherwise.
- Fixed a retrieval bug found along the way: `about` was missing from the
  BM25 stopword list in `src/retrieval.ts`. Because it's rare across the
  corpus, its inflated IDF let unrelated questions containing "about" (e.g.
  "write me a poem about trucks") slip past the confidence threshold.

## Data model change

- Added a `definition` field to every service in `data/services.json` (and
  `src/types.ts`) — a plain, generic explanation of what the qualification
  *is*, kept separate from the description of what NEDS *offers*. The old
  `summary` field conflated the two and buried core facts in parentheses
  (e.g. "35 hours every 5 years" for CPC), which a later request specifically
  asked to stop doing for "what is X" questions.

## Deterministic guardrails added

All of these bypass the model entirely (fixed text, not model-generated),
following the project's "facts outside the model" philosophy — reliability
over letting an LLM paraphrase a policy-sensitive reply:

| Trigger | Behaviour |
|---|---|
| Ordinary car-lesson questions | Fixed clarification that NEDS doesn't teach car lessons (wording iterated twice; detection broadened from exact phrases to a word+topic match after gaps were found) |
| Plain greeting ("hi"/"hello") | Fixed introduction, same text shown in the widget on load |
| On-topic but no confident match | `UNSURE_TEXT` |
| No vocabulary overlap with the knowledge base at all | `IRRELEVANT_TEXT` |
| Name / DOB / driving-licence number / email / phone volunteered | `PERSONAL_INFO_TEXT` — message never reaches the model |
| Callback or contact-detail request | `CALLBACK_DECLINE_TEXT` — the chat **does not** collect a name/phone/email for this at all (this reverses the original PoC's lead-capture flow, which used to ask for them) |
| Instructor-selection request (gender, age, race/ethnicity/nationality, or general "choose/prefer/same/different") | `INSTRUCTOR_SELECTION_TEXT` |
| Broad "what do you offer" question | Full bulleted course list (previously misrouted to a random tangential FAQ or no answer at all — a real routing bug, not just a formatting gap) |

The growing set of message-only bypasses was consolidated into one
table-driven `deterministicReply()` helper shared by `answer()` and
`answerStream()` in `src/pipeline.ts`, rather than tripling the same
if-block a fourth time.

## Answer style

The system prompt (`src/prompt.ts`) was rewritten in full, then extended
turn by turn with:

- **Personalisation** — speak as NEDS ("we offer..."), address the visitor
  directly ("you"/"your"), never open a sentence on a bare service name.
- **Information pacing** — answer only what was asked; a "what is X"
  question no longer gets price dragged in automatically
  (`src/facts.ts`'s `serviceFactsOnly()` vs `factsFor()`); ends with a
  varied, low-pressure offer rather than a fixed repeated CTA sentence.
- **Definitional questions** ("what is X") — explain the concept generically
  in its own sentence first, then connect it to what NEDS offers second,
  never the reverse; this is what the new `definition` field feeds.
- **Leading with the direct answer** — for "how much"/"how long"/"when"
  questions, the specific figure comes first, description second (reversed
  from the original ordering).
- **Reassurance for setbacks** — failing a test, costs, delays open with
  brief acknowledgement before the fact.

`src/llm.ts`'s mock renderer was reworked in parallel to actually match this
in the no-model preview: no more stacked fact-label fragments
("Category C1 — 3.5t — £1195"-style joins), no dash/colon labelling, price-
led phrasing for price questions, definition-led phrasing for "what is"
questions.

## Conversation memory

Added real (if minimal) session state — the pipeline was previously fully
stateless per message, even though `sessionId` existed unused in the request
schema:

- `src/session.ts` (new) — in-memory map remembering an outstanding pricing
  offer per session, 10-minute TTL.
- Whenever a narrow service question withholds price, that's now recorded as
  a pending offer. A short, unambiguous affirmative reply ("yes", "yes
  please", "sure", "go on", ...) resolves directly against it — giving the
  price for *that* service — rather than falling through to retrieval, where
  a bare "yes" could otherwise match some unrelated FAQ by coincidence. If
  nothing is pending, the bot asks a brief clarifying question instead of
  guessing.
- `sessionId` is now actually threaded end-to-end: the widget generates one
  per page load and sends it with every request; `src/server.ts` reads it
  from the validated body and passes it through to `answer()`/`answerStream()`.

## Widget (`public/widget.html`)

- Minimize toggle (top-left of the header) that collapses the widget to just
  its title bar, pinned to the top-left corner of the viewport via
  `position: fixed` while minimized; restores to its previous size
  (including any manual resize) when expanded again.
- Drag-to-resize handle, bottom-right corner, pointer-capture based.
- Text-size +/- controls, placed below the header and above the chat log.
- Page layout changed from centred to left-aligned.
- The greeting message is now a permanent chat bubble (same styling/behaviour
  as a real bot reply) instead of being deleted the moment the visitor sends
  their first message.

## Known limitations (raised but intentionally not fixed this session)

- Mock mode is a string-template stand-in, not true language generation — it
  approximates the style rules but can't always blend multiple facts as
  fluently as a live model would.
- A message that both names a specific service *and* asks a general question
  about it (e.g. "How do I sign up for HGV training?") still routes as a
  service/price answer rather than surfacing the more specific FAQ, because
  a literal service-name mention wins intent routing ahead of FAQ matching.
  Flagged twice; a safe general fix wasn't found (tested and rejected a
  retrieval-score-based approach — it also hijacked unrelated price answers
  in testing).
- "How do I get in touch?" (using "touch" rather than "contact") and
  "enrol" (rather than "sign up"/"book") aren't recognised by the relevant
  FAQs' current wording.

## Outstanding

- Local commit `873419a` made (repo-local git identity `dwebnomad
  <dwebnomad@gmail.com>` configured at the user's direction, since none was
  set and Claude Code's git safety rules don't permit changing config
  unprompted).
- `git push origin main` failed — no GitHub credential available in this
  environment (no `gh` CLI, no SSH key, empty keychain entry for
  github.com). Installed `gh` CLI v2.97.0 via direct binary download to
  `~/.local/bin` (no Homebrew present, same constraint as the earlier Node
  install). `gh auth login` was started interactively by the user and was
  still in progress when this note was written — push to GitHub still
  pending as a next step.
