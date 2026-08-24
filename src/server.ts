// The HTTP surface. Deliberately minimal: a health check, a JSON /chat, a
// streaming /chat/stream, and the demo widget. This is the shape Cloudflare will
// eventually front; everything model/admin stays off this service.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { services, prices } from "./knowledge.js";
import { answer, answerStream } from "./pipeline.js";
import { ChatRequestSchema } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const widgetHtml = readFileSync(join(here, "..", "public", "widget.html"), "utf8");

const app = new Hono();

// PoC CORS: permissive so the widget can be opened from file:// or any origin
// during the demo. In production this becomes an explicit origin allowlist.
app.use("*", cors());

// --- Very small in-memory rate limiter (per IP, sliding window) ---
// Production replaces this with Cloudflare rate limiting; this is a safety net.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > MAX_PER_WINDOW;
}
function clientIp(headers: Headers): string {
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local"
  );
}

app.get("/health", (c) =>
  c.json({ ok: true, mode: config.llm.mode, model: config.llm.model }),
);

app.get("/", (c) => c.html(widgetHtml));

// Feeds the widget's price calculator. Same approved services/prices the
// chat itself is grounded on — never a separate copy that could drift.
app.get("/catalogue", (c) => c.json({ services, prices }));

// Brand assets (logo, icon) for the widget.
app.use("/assets/*", serveStatic({ root: "./public" }));

// Shared validation for both chat routes.
function validate(
  raw: unknown,
): { ok: true; message: string; sessionId?: string } | { ok: false; error: string } {
  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const message = parsed.data.message.trim();
  if (message.length === 0) return { ok: false, error: "Empty message." };
  if (message.length > config.limits.maxMessageChars) {
    return { ok: false, error: `Message too long (max ${config.limits.maxMessageChars} characters).` };
  }
  return { ok: true, message, sessionId: parsed.data.sessionId };
}

app.post("/chat", async (c) => {
  if (rateLimited(clientIp(c.req.raw.headers))) {
    return c.json({ error: "Too many requests. Please slow down." }, 429);
  }
  const body = await c.req.json().catch(() => null);
  const v = validate(body);
  if (!v.ok) return c.json({ error: v.error }, 400);

  const response = await answer(v.message, v.sessionId);
  return c.json(response);
});

app.post("/chat/stream", async (c) => {
  if (rateLimited(clientIp(c.req.raw.headers))) {
    return c.json({ error: "Too many requests. Please slow down." }, 429);
  }
  const body = await c.req.json().catch(() => null);
  const v = validate(body);
  if (!v.ok) return c.json({ error: v.error }, 400);

  // Server-sent events: a meta frame first, then token frames, then done.
  const encoder = new TextEncoder();
  const streamBody = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      try {
        const gen = answerStream(v.message, v.sessionId, (meta) => send("meta", meta));
        for await (const delta of gen) send("token", delta);
        send("done", {});
      } catch (err) {
        send("token", "Sorry — something went wrong. Please contact the NEDS office.");
        send("done", {});
      } finally {
        controller.close();
      }
    },
  });

  return new Response(streamBody, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`NEDS chat PoC listening on http://localhost:${info.port}`);
  console.log(`  mode=${config.llm.mode}  model=${config.llm.model}  llm=${config.llm.baseUrl}`);
  console.log(`  open http://localhost:${info.port}/ for the widget`);
});
