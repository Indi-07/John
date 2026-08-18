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
      console.error(`[llm] upstream ${res.status} ${res.statusText}`);
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

// ---- Mock answer: a templated, grounded reply for demos without the model ----
function mockAnswer(messages: ChatMessage[]): string {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const factsMatch = user.match(/APPROVED FACTS:\n([\s\S]*?)\n\nVISITOR QUESTION/);
  const facts = factsMatch?.[1]?.trim() ?? "";
  if (!facts || facts.startsWith("(no matching")) {
    return "Thanks for your message. I don't have that to hand, but the NEDS office can help — please give us a call or send an email and the team will sort it out.";
  }
  const prices = facts
    .split("\n")
    .filter((l) => l.startsWith("PRICE "))
    .map((l) => l.replace(/^PRICE /, ""));
  const svc = facts
    .split("\n")
    .find((l) => l.startsWith("SERVICE "))
    ?.replace(/^SERVICE /, "");

  const parts: string[] = [];
  if (svc) parts.push(svc);
  if (prices.length) parts.push(`Current pricing — ${prices.slice(0, 3).join("; ")}.`);
  parts.push("If you'd like, I can arrange for the office to call you back.");
  return `[mock] ${parts.join(" ")}`;
}
