/**
 * Portable types for console-leaderboard signal collectors.
 *
 * PORTABILITY RULE: this file has zero imports from anywhere but Node stdlib.
 * When we port to howmanyareplaying (Postgres/raw SQL), only the runner needs
 * to change; these types and the collectors that produce them stay put.
 */

export type ConsolePlatform = "steam" | "ps5" | "xbox";
export type LeaderboardWindow = "d7" | "d30" | "d90" | "m12" | "ltd";
export type BusinessModel = "paid" | "free_to_play" | "subscription_only" | "unknown";

/**
 * One captured rating snapshot for a title on a platform.
 * Corresponds 1:1 with a `store_rating_signal_daily` row.
 */
export interface StoreRatingSnapshot {
  platform: ConsolePlatform;
  captureDate: string;                       // YYYY-MM-DD (UTC)
  sourceEndpoint: string;                    // e.g. "steam:appreviewhistogram", "xbox:displaycatalog", "ps:wcaProductStarRatingRetrive"
  ratingCount: number | null;                // total lifetime rating count
  avgRating: number | null;                  // 0-5 typical; null when store doesn't return one
  distributionJson: string | null;           // JSON string; shape is source-specific (see per-collector docs)
  windowLabel: string | null;                // "d7" | "d30" | "ltd" when the source natively returns a window; null otherwise
  isNativeWindow: boolean;                   // true iff windowLabel came directly from the source (not derived by us)
  skuCount: number;                          // how many SKUs summed into this row (base + edition only)
  rawJson: string | null;                    // upstream response fragment, kept for divergence + audit
}

/**
 * Steam-only: one histogram bucket. `steam_review_history` grain.
 */
export interface SteamReviewBucket {
  appId: string;
  bucketStart: number;                       // unix seconds, from Valve
  bucketGranularity: "day" | "week" | "month";
  recommendationsUp: number;
  recommendationsDown: number;
  sourceEndpoint: string;                    // always "steam:appreviewhistogram"
}

export interface CollectorFailure {
  platform: ConsolePlatform;
  externalSku?: string;
  reason: string;
  cause?: unknown;
}

/**
 * A soft-skip: the storefront answered but returned no data for this SKU.
 * This is a business-as-usual outcome for delisted/unpublished/upcoming
 * editions that appear on a sales chart but no longer have a live PDP.
 * The runner should NOT treat these as failures (no on-call alert, no
 * exit-code bump). They just don't produce a rating snapshot, which
 * means the leaderboard's `COALESCE(rating_count,0) DESC` naturally
 * sinks them to the bottom.
 */
export interface CollectorSkip {
  platform: ConsolePlatform;
  externalSku?: string;
  reason: string;                          // e.g. "productRetrieve returned no data (likely delisted)"
}

export interface CollectorResult<T> {
  ok: T[];
  failed: CollectorFailure[];
  /**
   * Empty for collectors that don't distinguish soft-skips (Steam, Xbox
   * as of 2026-09-11). PS routes delisted-edition cases here so they
   * don't inflate the `failed` count.
   */
  skipped?: CollectorSkip[];
}

// ─── Fetch helper w/ timeout + retry-once ────────────────────────────────────

export interface FetchOpts {
  timeoutMs?: number;                        // default 15000
  headers?: Record<string, string>;
  retryOnce?: boolean;                       // default true (retries once on network error or 5xx)
}

export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const retry = opts.retryOnce !== false;

  const attempt = async (): Promise<T> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: opts.headers, signal: ctl.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText} at ${url} :: ${body.slice(0, 200)}`);
      }
      return await res.json() as T;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await attempt();
  } catch (e) {
    if (!retry) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    // retry once on abort or 5xx; do NOT retry on 4xx
    if (msg.includes("HTTP 4")) throw e;
    await new Promise(r => setTimeout(r, 500));
    return await attempt();
  }
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
