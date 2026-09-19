/**
 * Thin Perplexity Sonar / Agent-API HTTP client for the SignalPulse
 * (Node/TS) server.
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
 *
 * v5.0 (2026-09-19, Landing 3 of Sonar deprecation): Perplexity Sonar
 * Chat Completions is being deprecated on 2026-09-27. This module now
 * routes to Perplexity's Agent API (`POST /v1/agent`) when the
 * `LLM_PRIMARY_DIGEST` env var is set to `agent-api`. Default remains
 * `sonar` for zero behavioral change until an operator flips the flag.
 *
 * Wire-level differences (Sonar chat/completions → Agent API):
 *   messages         → input (array with role/content items)
 *   system message   → instructions (top-level)
 *   model            → preset  ("low" == sonar-pro behavioral match)
 *   web_search_options.search_context_size
 *                    → tools[0].search_context_size (still supported)
 *   search_before/after_date_filter (top-level)
 *                    → tools[0].filters.search_{before,after}_date_filter
 *   response.choices[0].message.content
 *                    → walk response.output[]: find item with type='message'
 *                      and extract .content[0].text
 *   response.citations (top-level)
 *                    → walk response.output[]: find item with
 *                      type='search_results' and extract .results[].url
 *
 * We preserve the same {text, citations} return shape so
 * leaderboard-digest.ts does not need to change.
 */
import { storage } from "./storage";

const SONAR_URL = "https://api.perplexity.ai/chat/completions";
const AGENT_URL = "https://api.perplexity.ai/v1/agent";
const DEFAULT_MODEL = "sonar";
const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * Backend selector for this call. Reads LLM_PRIMARY_DIGEST env var
 * (with legacy LLM_PRIMARY as a global fallback for parity with the
 * Python-side unified llm_client.py). Values: 'sonar' (default),
 * 'agent-api'. Anything else falls back to 'sonar' to preserve current
 * behavior on typo.
 */
function selectedBackend(): "sonar" | "agent-api" {
  const raw = (process.env.LLM_PRIMARY_DIGEST ?? process.env.LLM_PRIMARY ?? "").toLowerCase();
  return raw === "agent-api" ? "agent-api" : "sonar";
}

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

// ---------------------------------------------------------------------------
// Agent API path (Landing 3, 2026-09-19)
// ---------------------------------------------------------------------------

/**
 * Extract the assistant message text from an Agent API response by walking
 * `output[]` for the first item with type='message', then reading
 * `.content[0].text`. Returns "" if not found. See migration guide's
 * response-mapping table.
 */
export function __extractAgentText(parsed: any): string {
  const output = Array.isArray(parsed?.output) ? parsed.output : [];
  for (const item of output) {
    if (item?.type !== "message") continue;
    const contents = Array.isArray(item?.content) ? item.content : [];
    for (const c of contents) {
      if (typeof c?.text === "string" && c.text.trim().length > 0) {
        return c.text.trim();
      }
    }
  }
  // Agent API also exposes a convenience top-level `output_text` on some
  // shapes; fall back to it if the walk turns up empty.
  if (typeof parsed?.output_text === "string" && parsed.output_text.trim().length > 0) {
    return parsed.output_text.trim();
  }
  return "";
}

/**
 * Extract citation URLs from an Agent API response by walking `output[]`
 * for the first item with type='search_results' and collecting the `.url`
 * of each result. Returns [] if search was not triggered or turned up
 * nothing (which is legal even when web search is forced).
 */
export function __extractAgentCitations(parsed: any): string[] {
  const output = Array.isArray(parsed?.output) ? parsed.output : [];
  const urls: string[] = [];
  for (const item of output) {
    if (item?.type !== "search_results") continue;
    const results = Array.isArray(item?.results) ? item.results : [];
    for (const r of results) {
      if (typeof r?.url === "string" && /^https?:\/\//i.test(r.url)) {
        urls.push(r.url);
      }
    }
  }
  return urls;
}

async function callAgentApi(
  prompt: string,
  opts: {
    system?: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    searchContextSize?: "low" | "medium" | "high";
    searchAfterDateFilter?: string;
    searchBeforeDateFilter?: string;
  },
): Promise<SonarResult | null> {
  const apiKey = storage.getSetting("perplexity_api_key")?.value;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    // Build the web_search tool block. Digest work requires citations; force
    // search via tool_choice so a preset that would otherwise skip search
    // still returns grounded output.
    const searchFilters: Record<string, string> = {};
    if (opts.searchAfterDateFilter) searchFilters.search_after_date_filter = opts.searchAfterDateFilter;
    if (opts.searchBeforeDateFilter) searchFilters.search_before_date_filter = opts.searchBeforeDateFilter;
    const webSearchTool: Record<string, unknown> = {
      type: "web_search",
      search_context_size: opts.searchContextSize ?? "medium",
    };
    if (Object.keys(searchFilters).length > 0) webSearchTool.filters = searchFilters;

    const body = {
      // preset:"low" is the Agent-API behavioral match for sonar-pro per the
      // official migration guide's models-and-presets.md.
      preset: "low",
      instructions: opts.system ?? DEFAULT_SYSTEM,
      input: [
        { role: "user", content: prompt },
      ],
      max_output_tokens: opts.maxTokens ?? 350,
      temperature: opts.temperature ?? 0.2,
      tools: [webSearchTool],
      tool_choice: { type: "web_search" },
    };

    const res = await fetch(AGENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[sonar-client] Agent API HTTP ${res.status}: ${errBody.slice(0, 300)}`);
      return null;
    }

    const parsed = await res.json();
    const text = __extractAgentText(parsed);
    if (text.length === 0) return null;
    const citations = __extractAgentCitations(parsed);
    return { text, citations };
  } catch (err: any) {
    console.error(`[sonar-client] Agent API call failed: ${err?.message ?? err}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Test-only backend override (bypasses env var). Undefined restores env-driven behavior.
let __backendOverride: "sonar" | "agent-api" | undefined;
export function __setBackendOverride(b: "sonar" | "agent-api" | undefined): void {
  __backendOverride = b;
}

/**
 * Router: read env-selected (or test-overridden) backend and dispatch. Same
 * signature/return-shape as callSonar for callers that predate the split.
 */
export async function callLlm(
  prompt: string,
  opts: Parameters<typeof callSonar>[1] = {},
): Promise<SonarResult | null> {
  const backend = __backendOverride ?? selectedBackend();
  if (backend === "agent-api") return callAgentApi(prompt, opts);
  return callSonar(prompt, opts);
}
