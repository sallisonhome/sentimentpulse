/**
 * Thin Perplexity Sonar HTTP client for the SignalPulse (Node/TS) server.
 *
 * Mirrors backend/services/sonar_client.py's pattern (strict-grounding
 * system prompt, low web-search context, raise/return-null on any failure)
 * so behavior stays consistent across the Python and TS sides of the repo.
 * Currently the ONLY caller is the weekly digest narrative — see
 * leaderboard-digest.ts::generateDigestNarrative().
 *
 * No existing LLM client existed in this server before this file (v4.0,
 * 2026-08-14) — added specifically for the per-section digest narrative
 * paragraph, gated on the "perplexity_api_key" app setting.
 */
import { storage } from "./storage";

const SONAR_URL = "https://api.perplexity.ai/chat/completions";
const DEFAULT_MODEL = "sonar";
const DEFAULT_TIMEOUT_MS = 20_000;

const DEFAULT_SYSTEM = (
  "You are a game industry analyst writing a short, factual weekly summary " +
  "for an internal leadership digest email. You ground every sentence " +
  "STRICTLY in the numbers provided in the user's message. You never use " +
  "outside web knowledge, never invent numbers, titles, or trends not " +
  "present in the provided data, and never speculate about causes unless " +
  "explicitly given. Write 2-3 plain sentences, no markdown, no bullet " +
  "points, no headers."
);

export function sonarAvailable(): boolean {
  return !!storage.getSetting("perplexity_api_key")?.value;
}

/**
 * POST a single prompt to Sonar. Returns the response text, or `null` on
 * any failure (no key, HTTP error, timeout, malformed response) — callers
 * must degrade gracefully (omit the narrative) rather than fail the send.
 * Never throws.
 */
export async function callSonar(
  prompt: string,
  opts: { model?: string; system?: string; maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const apiKey = storage.getSetting("perplexity_api_key")?.value;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(SONAR_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_MODEL,
        messages: [
          { role: "system", content: opts.system ?? DEFAULT_SYSTEM },
          { role: "user", content: prompt },
        ],
        max_tokens: opts.maxTokens ?? 220,
        temperature: opts.temperature ?? 0.2,
        web_search_options: { search_context_size: "low" },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[sonar-client] Sonar HTTP ${res.status}: ${body.slice(0, 300)}`);
      return null;
    }

    const parsed = await res.json();
    const text = parsed?.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
  } catch (err: any) {
    console.error(`[sonar-client] Sonar call failed: ${err?.message ?? err}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
