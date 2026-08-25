// Client for the local model (LM Studio's OpenAI-compatible server on the Mac
// Studio). Enforces a hard timeout and never throws into the request path — on
// any failure the caller falls back to a phone/email hand-off.

import { config } from "./config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmResult {
  text: string;
  ok: boolean; // false => caller should hand off
}

// Non-streaming completion with a hard wall-clock timeout.
export async function complete(messages: ChatMessage[]): Promise<LlmResult> {
  if (config.llm.mode === "mock") {
    return { text: mockAnswer(messages), ok: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        messages,
        temperature: 0.3,
        max_tokens: 400,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[llm] upstream ${res.status} ${res.statusText}: ${body}`);
      return { text: "", ok: false };
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    return text ? { text, ok: true } : { text: "", ok: false };
  } catch (err) {
    const reason = err instanceof Error ? err.name : String(err);
    console.error(`[llm] request failed: ${reason}`);
    return { text: "", ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// Streaming completion. Yields text deltas. Throws on failure so the caller can
// decide how to hand off mid-stream.
export async function* stream(
  messages: ChatMessage[],
): AsyncGenerator<string, void, unknown> {
  if (config.llm.mode === "mock") {
    // Emit the mock answer word-by-word so the widget UX matches live mode.
    for (const word of mockAnswer(messages).split(" ")) {
      yield word + " ";
    }
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        messages,
        temperature: 0.3,
        max_tokens: 400,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`upstream ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Server-sent events are separated by newlines; each data line is JSON.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // ignore keep-alive / partial lines
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

// Pulls just the "£amount unit" headline out of a formatted PRICE line
// (`${label}: £${amount} ${unit}${includes}${note}` — see facts.ts's
// priceLine()). Slices from the first "£" rather than splitting the whole
// line on " — ", since a real price label can itself contain " — " (e.g.
// "Beginner — 1 person, 3 days") and would otherwise get cut at the wrong
// dash, well before the actual amount.
function priceHeadline(line: string): string | undefined {
  const idx = line.indexOf("£");
  if (idx === -1) return undefined;
  return line
    .slice(idx)
    .replace(/\s*\(includes:[^)]*\)/, "")
    .split(" — ")[0]
    ?.trim();
}

// Generic filler words that would otherwise dominate every section's score
// equally and drown out the words that actually distinguish one course/job
// from another — mirrors src/retrieval.ts's STOP list in spirit (see that
// file's own comment on why a missing stopword inflates unrelated matches),
// but kept separate since this is scoring markdown doc sections, not FAQs.
const REFERENCE_DOC_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "about", "what", "which", "who", "how", "why", "when", "where", "is",
  "are", "do", "does", "i", "my", "me", "want", "would", "like", "can",
  "could", "you", "your", "it", "this", "that", "these", "those", "be",
  "as", "at", "by", "from", "into", "if", "not", "get", "have",
]);

function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9+]+/g)
      ?.filter((w) => w.length > 1 && !REFERENCE_DOC_STOPWORDS.has(w)) ?? []
  );
}

// Picks whichever "## "-headed section of a reference doc shares the most
// keywords with the visitor's question — a rough stand-in for the live
// model's job of reading the whole doc and answering only the relevant
// part. Returns undefined (not a wrong guess) if nothing in the question
// overlaps any section, so the caller can fall through to the generic
// fallback instead of returning an arbitrary section.
//
// A plain match-count would pick the wrong section on a real query like "I
// want to be an ambulance driver, what qualifications do I need?" — words
// like "need"/"qualification"/"driving" repeat throughout every section of
// a job-guide doc and say nothing about which one is relevant, while
// "ambulance" (confined to a single section) is exactly the word that
// should decide it, but a bare count lets the generic words from the
// longest section (which has the most words to coincidentally match) drown
// it out. So each question word is weighted by how RARE it is across the
// doc's own sections — same idea as src/retrieval.ts's BM25 rareness
// weighting (see that file's STOP-list comment for the same failure mode
// in a different corpus), simplified here to a one-off scan since this
// only ever runs over a handful of sections per request, not a persistent
// index.
function bestMatchingSection(doc: string, question: string): string | undefined {
  const qWords = new Set(tokenize(question));
  if (!qWords.size) return undefined;

  const sections = doc.split(/\n(?=## )/).filter((s) => s.trim().startsWith("##"));
  if (!sections.length) return undefined;
  const sectionTokenSets = sections.map((s) => new Set(tokenize(s)));

  const weight = new Map<string, number>();
  for (const w of qWords) {
    const sectionsContaining = sectionTokenSets.filter((set) => set.has(w)).length;
    if (sectionsContaining > 0) weight.set(w, 1 / sectionsContaining);
  }

  // Both reference docs open or close with a deliberate whole-doc overview
  // section — course-comparison.md's "Quick comparison table" (every course
  // as a row) and "Overall takeaway", courses-by-job.md's "Summary by type
  // of need" — that name-checks nearly every course in passing. Rareness
  // weighting alone still lets one of these win on a close question by
  // sheer word count, since it's by far the longest/broadest section and so
  // has the most chances to coincidentally match a few more low-weight
  // words than the one specific section that's actually the right answer
  // (verified live: "difference between forklift training and OLAT" picked
  // the table over Group 3, the section actually named for that exact
  // pair, until this exclusion was added). Excluded from candidacy, same as
  // rules 32/33 in prompt.ts ask a live model to answer the specific
  // course/job asked, not the whole doc.
  let best: { score: number; index: number } | undefined;
  sectionTokenSets.forEach((tokens, i) => {
    if (/^##\s*(summary|overall|quick comparison)/i.test(sections[i]!)) return;
    let score = 0;
    for (const [w, wt] of weight) {
      if (tokens.has(w)) score += wt;
    }
    if (score > 0 && (!best || score > best.score)) best = { score, index: i };
  });
  if (!best) return undefined;

  const section = sections[best.index]!;
  const heading = section.match(/^##\s*(.+)/)?.[1]?.trim();
  const body = section.replace(/^##.*(\n|$)/, "").trim();
  return heading ? `${heading}: ${body}` : body;
}

// ---- Mock answer: a templated, grounded reply for demos without the model ----
// The pipeline only calls complete()/stream() once it has non-empty facts to
// ground on (see pipeline.ts's UNSURE_TEXT short-circuit), so `facts` here is
// always populated.
function mockAnswer(messages: ChatMessage[]): string {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const factsMatch = user.match(/APPROVED FACTS:\n([\s\S]*?)\n\nVISITOR QUESTION/);
  const facts = factsMatch?.[1]?.trim() ?? "";
  const lines = facts.split("\n");

  // Rule 19: a "Do you...", "Can you...", "Is it...", "Does NEDS..."-shaped
  // question gets a leading "Yes"/"No" as its own opening word — never left
  // for the person to infer from the detail that follows.
  const questionMatch = user.match(/VISITOR QUESTION:\n([\s\S]*?)\n\nAnswer the visitor now/);
  const question = questionMatch?.[1]?.trim() ?? "";
  const isYesNoQuestion = /^(do|does|is|are|can|could|will|would)\b/i.test(question);

  // Rule 20: genuine possessive/ownership phrasing about NEDS's own course
  // — "your X" (e.g. "What are your trailer lessons?", "What's your
  // forklift course?") or "do/does you offer/have/run/provide X" (e.g. "Do
  // you offer forklift training?") — signals ownership, not a general
  // concept, so lead with what NEDS offers instead of rule 5's
  // definition-first ordering. Deliberately does NOT match a bare "you" —
  // that used to also catch the conversational opener "can/could you
  // tell/explain/describe/say about X" (e.g. "Can you tell me about
  // C+E?"), which addresses the assistant, not NEDS's course, and is a
  // plain "what is X" question that belongs on rule 5's definition-first
  // path instead.
  const isOwnershipQuestion =
    /\byour\b/i.test(question) ||
    /\b(?:do|does)\s+you\s+(?:offer|have|run|provide)\b/i.test(question);

  const scope = lines.find((l) => l.startsWith("SCOPE "))?.replace(/^SCOPE /, "");
  if (scope) return `[mock] ${scope}`;

  if (facts.startsWith("AVAILABILITY:")) {
    return "[mock] I don't have live availability connected in this preview, but you can check the NEDS website or get in touch with the team directly for current dates.";
  }

  // The course-comparison and courses-by-job facts blocks are whole markdown
  // reference docs (see pipeline.ts's isCourseComparisonQuery/
  // isJobQualificationQuery routing), not fact lines in the SERVICE/PRICE/
  // DEFINITION shape every other branch here understands — without this
  // branch, a query routed to either doc fell all the way through to the
  // generic "Happy to help with that." fallback at the bottom of this
  // function, since nothing below could parse a line out of it either. A
  // live model is asked (rules 32/33 in prompt.ts) to answer only the
  // specific course(s)/job asked about rather than dump the whole doc; this
  // approximates the same scoping by picking whichever "## " section of the
  // doc shares the most keywords with the visitor's question.
  if (facts.startsWith("COURSE COMPARISON REFERENCE:") || facts.startsWith("COURSES BY JOB REFERENCE:")) {
    const doc = facts.replace(/^COURSE COMPARISON REFERENCE:\n|^COURSES BY JOB REFERENCE:\n/, "");
    const section = bestMatchingSection(doc, question);
    if (section) return `[mock] ${section}`;
  }

  if (facts.startsWith("BROAD_OFFER_LIST")) {
    // A broad "what do you offer" question wants the full range at a
    // glance, not a single narrowed-down answer — and no yes/no opener,
    // since it isn't a yes/no question.
    const names = lines
      .filter((l) => l.startsWith("SERVICE "))
      .map((l) => l.replace(/^SERVICE /, "").split(": ")[0] ?? l);
    const bullets = names.map((n) => `- ${n}`).join("\n");
    return `[mock] We offer a range of courses, including:\n${bullets}\n\nLet me know if you'd like more detail on any of these.`;
  }

  if (facts.startsWith("CONFIRMED_OFFER")) {
    // The visitor just said "yes please" to the bot's own pricing offer (see
    // pipeline.ts's resolveAffirmative) — acknowledge and follow through,
    // don't treat the bare "yes" as a fresh unrelated question.
    const svcLine2 = lines.find((l) => l.startsWith("SERVICE "))?.replace(/^SERVICE /, "");
    const name = svcLine2?.split(": ")[0];
    const priceLine2 = lines.find((l) => l.startsWith("PRICE "))?.replace(/^PRICE /, "");
    const amount = priceLine2 ? priceHeadline(priceLine2) : undefined;
    if (name && amount) {
      return `[mock] Sure — ${name} is ${amount}. Let me know if you'd like to know anything else.`;
    }
  }

  const definitionText = lines.find((l) => l.startsWith("DEFINITION "))?.replace(/^DEFINITION /, "");
  const priceLines = lines.filter((l) => l.startsWith("PRICE ")).map((l) => l.replace(/^PRICE /, ""));
  const svcLine = lines.find((l) => l.startsWith("SERVICE "))?.replace(/^SERVICE /, "");
  const faqAnswer = lines.find((l) => l.startsWith("FAQ Q: "))?.match(/ A: (.+)$/)?.[1];

  const amounts = priceLines
    .slice(0, 3)
    .map((l) => priceHeadline(l))
    .filter((a): a is string => Boolean(a));
  const priceSentence = amounts.length
    ? amounts.length > 1
      ? `At NEDS, prices are ${amounts.join(", ")}, depending on the course.`
      : `At NEDS, it's ${amounts[0]}.`
    : undefined;

  // Full sentences, not stacked fact-labels — those (inclusions, exclusions,
  // the service name as a separate label) are still in the approved facts
  // (see facts.ts), so a live model can weave them in naturally if the
  // visitor asks a follow-up; the mock preview just can't rephrase like that.
  const parts: string[] = [];
  if (definitionText && svcLine) {
    const name = svcLine.split(": ")[0] ?? svcLine;
    if (isOwnershipQuestion) {
      // "What are your X" pattern: "your"/"you" signals the visitor is
      // asking about NEDS's own offering, not the general concept — lead
      // with the offer, definition second, the reverse of the branch below.
      parts.push(`We offer ${name} here at NEDS.`);
      parts.push(definitionText);
    } else {
      // "What is X" pattern: plain, generic explanation as its own sentence
      // first, THEN connect it to what NEDS offers — never the other way round.
      parts.push(definitionText);
      parts.push(`We offer ${name} here at NEDS, if that's something you need.`);
    }
  } else if (svcLine && priceSentence) {
    // Direct factual question (e.g. "how much is..."): lead with the direct
    // answer — the price — and put the description second, as supporting
    // context, not the headline.
    const summary = svcLine.split(/: (.+)/)[1] ?? svcLine;
    const lowered = summary.charAt(0).toLowerCase() + summary.slice(1);
    parts.push(priceSentence);
    parts.push(`This covers ${lowered}`);
  } else if (svcLine) {
    // No price fact here (e.g. a broad "what do you offer" browse, not a
    // specific question) — nothing to lead with, so describe the service.
    const summary = svcLine.split(/: (.+)/)[1] ?? svcLine;
    const lowered = summary.charAt(0).toLowerCase() + summary.slice(1);
    parts.push(`We offer ${lowered}`);
  } else if (priceSentence) {
    parts.push(priceSentence);
  }
  if (!parts.length && faqAnswer) parts.push(faqAnswer);
  if (!parts.length) parts.push("Happy to help with that.");

  // Rule 19: prefix the lead sentence with "Yes"/"No" as its own opening
  // word for a yes/no-shaped question, rather than leaving the person to
  // infer the answer from the detail that follows. Facts reaching the model
  // are always things NEDS actually does (out-of-scope/unmatched cases are
  // declined deterministically before this point — see pipeline.ts), so the
  // lead sentence defaults "Yes" unless it's itself phrased as a negation
  // (an FAQ answer along the lines of "We do not...").
  const [lead] = parts;
  if (isYesNoQuestion && lead && !/^(yes|no)\b/i.test(lead.trim())) {
    const isNegative = /\b(not|n't|never|no longer)\b/i.test(lead);
    const opener = isNegative ? "No" : "Yes";
    parts[0] = `${opener} — ${lead.charAt(0).toLowerCase()}${lead.slice(1)}`;
  }

  // Information pacing: a service_query deliberately doesn't get price facts
  // (see pipeline.ts's serviceFactsOnly) — so if we described a service but
  // withheld its price, offer it as a low-pressure follow-up rather than
  // dumping it in by default.
  if (svcLine && !priceLines.length) {
    parts.push("Want me to run through pricing too?");
  }

  return `[mock] ${parts.join(" ")}`;
}
