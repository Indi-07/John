// Central configuration, read once from the environment.
// Keeping this in one place means the answer path never reaches for process.env.

import { existsSync } from "node:fs";

// Load .env (Node built-in) if present, so `npm run dev` and scripts pick up
// local config without a dotenv dependency.
try {
  if (existsSync(".env") && typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch {
  // No/invalid .env — fall back to process.env and defaults.
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
}

export const config = {
  port: num("PORT", 8787),
  llm: {
    baseUrl: str("LLM_BASE_URL", "http://localhost:1234/v1"),
    model: str("LLM_MODEL", "qwen3-4b"),
    apiKey: str("LLM_API_KEY", "lm-studio"),
    timeoutMs: num("LLM_TIMEOUT_MS", 8000),
    // "live" calls the model; "mock" returns a templated grounded answer.
    mode: (str("LLM_MODE", "live") === "mock" ? "mock" : "live") as
      | "live"
      | "mock",
  },
  limits: {
    maxMessageChars: num("MAX_MESSAGE_CHARS", 600),
    maxAnswerWords: num("MAX_ANSWER_WORDS", 120),
  },
} as const;
