/**
 * GramIQ Academy — minimal Gemini client wrapper.
 *
 * The original app's lib/gemini/client.ts (a multi-key "circuit breaker"
 * manager) was never present in the handover snapshot this backend was
 * built from, so quiz-generator.ts's `geminiManager.executeWithRetry(fn)`
 * call had no implementation to port. This is a fresh, deliberately smaller
 * replacement: a single API key (GEMINI_API_KEY), retried with backoff on
 * transient failures. It satisfies the same call shape so quiz-generator.ts
 * did not need to change.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../../config/env";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

function isTransient(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b(429|500|502|503|504)\b/.test(message) || /overloaded|rate.?limit|timeout/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cachedClient: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  }
  return cachedClient;
}

export const geminiManager = {
  /** Runs `fn` against the Gemini client, retrying transient errors (rate limits, 5xx, overload) with exponential backoff. Non-transient errors (bad request, schema issues) fail immediately. */
  async executeWithRetry<T>(fn: (client: GoogleGenerativeAI) => Promise<T>): Promise<T> {
    const client = getClient();
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await fn(client);
      } catch (err) {
        lastError = err;
        if (!isTransient(err) || attempt === MAX_RETRIES - 1) throw err;
        await sleep(BASE_DELAY_MS * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Gemini request failed after retries.");
  },
};
