/**
 * Thin Perplexity Sonar HTTP client for the SignalPulse (Node/TS) server.
 *
 * Mirrors backend/services/sonar_client.py's pattern (raise/return-null on
 * any failure) so behavior stays consistent across the Python and TS sides
 * of the repo. Currently the ONLY caller is the weekly digest narrative —
 * see leaderboard-digest.ts::generateDigestNarrative().
 *
 * No existing LLM client existed in this server before this file (v4.0,
 * 2026-08-14) — added specifically for the per-section digest narrative
 * paragraph, gated on the "perplexity_api_key" app setting.
 *
 * v4.1 (2026-08-14): upgraded from a strict "numbers-only, no outside
 * knowledge" prompt to a grounded-research prompt — callers now WANT Sonar
 * to search the web for real, dated news (Steam sales/discounts, patch/DLC
 * beats, reviews, showcases) about the specific named titles during the
 * digest week, and to call out a likely causal connection to the reported
 * metrics when (and only when) it finds a dated source. Added date-scoped
 * search filters and citation passthrough so the digest can show sources.
 */
import { storage } from "./storage";

const SONAR_URL = "https://api.perplexity.ai/chat/completions";
const DEFAULT_MODEL = "sonar";
const DEFAULT_TIMEOUT_MS = 25_000;

const DEFAULT_SYSTEM = (
  "You are a game industry analyst writing a short, factual paragraph for " +
  "an internal leadership digest email. Ground every number STRICTLY in " +
  "the data given to you in the user's message — never invent or alter a " +
  "number, title, or trend that isn't present there. Separately, use web " +
  "search to check for real, dated news about the SPECIFIC named titles " +
  "(and their Steam App IDs, if given) during the stated week: Steam " +
  "storefront sales/discounts, Steam festival or event inclusion, patch or " +
  "DLC releases, major reviews, streamer or showcase coverage, or notable " +
  "controversies. If you find a specific, dated source for a title that " +
  "falls within or in the few days just before the stated week, AND that " +
  "title's numbers moved notably that week, you may note that the event " +
  "likely contributed to the outcome — phrase it as \"likely\" or \"may " +
  "have contributed to\", never as certain causation. If you find no such " +
  "event for a title, or its numbers didn't move notably, just report its " +
  "numbers plainly with no speculation about cause. Never fabricate an " +
  "event, a discount, or a source. Write 2-4 plain sentences, no markdown, " +
  "no bullet points, no headers, no raw URLs in the text itself."
);

export function sonarAvailable(): boolean {
  return !!storage.getSetting("perplexity_api_key")?.value;
}

export interface SonarResult {
  text: string;
  citations: string[];
}

/**
 * POST a single prompt to Sonar. Returns `{text, citations}`, or `null` on
 * any failure (no key, HTTP error, timeout, malformed response) — callers
 * must degrade gracefully (omit the narrative) rather than fail the send.
 * Never throws.
 */
export async function callSonar(
  prompt: string,
  opts: {
    model?: string;
    system?: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    searchContextSize?: "low" | "medium" | "high";
    /** MM/DD/YYYY — only return/ground on web results published after this date. */
    searchAfterDateFilter?: string;
    /** MM/DD/YYYY — only return/ground on web results published before this date. */
    searchBeforeDateFilter?: string;
  } = {},
): Promise<SonarResult | null> {
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
        max_tokens: opts.maxTokens ?? 350,
        temperature: opts.temperature ?? 0.2,
        web_search_options: { search_context_size: opts.searchContextSize ?? "medium" },
        ...(opts.searchAfterDateFilter ? { search_after_date_filter: opts.searchAfterDateFilter } : {}),
        ...(opts.searchBeforeDateFilter ? { search_before_date_filter: opts.searchBeforeDateFilter } : {}),
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
    if (typeof text !== "string" || text.trim().length === 0) return null;
    const rawCitations = Array.isArray(parsed?.citations) ? parsed.citations : [];
    const citations = rawCitations.filter((c: unknown): c is string => typeof c === "string" && /^https?:\/\//i.test(c));
    return { text: text.trim(), citations };
  } catch (err: any) {
    console.error(`[sonar-client] Sonar call failed: ${err?.message ?? err}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
