/**
 * Steam collector — appreviewhistogram + review-summary rollup.
 *
 * Endpoint: https://store.steampowered.com/appreviewhistogram/{appid}?l=english
 * Public, no key. `recent` = 30 daily buckets (day granularity, unix seconds).
 * `rollups` = weekly OR monthly per title (Valve chooses per-title). READ
 * `rollup_type` from the response — never assume. Phase 0 probe (2026-09-10):
 * 4/5 fixture appids were monthly, 1 was weekly (3164500).
 *
 * We derive the daily/lifetime rating snapshot from the histogram and store
 * every raw bucket separately in steam_review_history so windowed estimates
 * later can sum a specific date range without re-fetching.
 */

import { CollectorFailure, CollectorResult, SteamReviewBucket, StoreRatingSnapshot, fetchJson, todayUtc } from "./types";

interface HistogramBucket {
  date: number;                              // unix seconds
  recommendations_up: number;
  recommendations_down: number;
}

interface HistogramResponse {
  success: number;
  results: {
    start_date: number;
    end_date: number;
    weeks: number;
    rollup_type: "day" | "week" | "month";
    recent?: HistogramBucket[];
    rollups?: HistogramBucket[];
    start_date_range?: number;
    end_date_range?: number;
  };
}

const ENDPOINT = "steam:appreviewhistogram";

export interface SteamCollectorInput {
  titleId: number;
  appId: string;                             // Steam appid, as string
}

export interface SteamCollectorOutput {
  snapshot: StoreRatingSnapshot;
  buckets: SteamReviewBucket[];
}

/**
 * Fetch one title's histogram and normalize it.
 * Portable: no imports from server/*, no DB access.
 */
export async function fetchSteamRatingSignal(input: SteamCollectorInput): Promise<SteamCollectorOutput> {
  const url = `https://store.steampowered.com/appreviewhistogram/${encodeURIComponent(input.appId)}?l=english`;
  const raw = await fetchJson<HistogramResponse>(url, { timeoutMs: 15000 });

  if (!raw || raw.success !== 1 || !raw.results) {
    throw new Error(`steam histogram not-successful for appid=${input.appId}`);
  }

  const r = raw.results;
  const recent = Array.isArray(r.recent) ? r.recent : [];
  const rollups = Array.isArray(r.rollups) ? r.rollups : [];
  const rollupType: "day" | "week" | "month" =
    (r.rollup_type === "day" || r.rollup_type === "week" || r.rollup_type === "month") ? r.rollup_type : "week";

  // Every daily "recent" bucket → steam_review_history day-grain.
  // Every "rollups" bucket → steam_review_history at whatever grain Valve gave us.
  const buckets: SteamReviewBucket[] = [];
  for (const b of recent) {
    if (typeof b?.date !== "number") continue;
    buckets.push({
      appId: input.appId,
      bucketStart: b.date,
      bucketGranularity: "day",
      recommendationsUp: b.recommendations_up ?? 0,
      recommendationsDown: b.recommendations_down ?? 0,
      sourceEndpoint: ENDPOINT,
    });
  }
  for (const b of rollups) {
    if (typeof b?.date !== "number") continue;
    buckets.push({
      appId: input.appId,
      bucketStart: b.date,
      bucketGranularity: rollupType,
      recommendationsUp: b.recommendations_up ?? 0,
      recommendationsDown: b.recommendations_down ?? 0,
      sourceEndpoint: ENDPOINT,
    });
  }

  // Snapshot = lifetime up/down summed from rollups (Valve returns the full lifetime in weekly/monthly grain).
  // avg_rating derived as up / (up + down) * 5 for a 0-5 rating parity with the other stores.
  let totalUp = 0, totalDown = 0;
  for (const b of rollups) {
    totalUp += b.recommendations_up ?? 0;
    totalDown += b.recommendations_down ?? 0;
  }
  const total = totalUp + totalDown;
  const avgRating = total > 0 ? (totalUp / total) * 5 : null;

  const snapshot: StoreRatingSnapshot = {
    platform: "steam",
    captureDate: todayUtc(),
    sourceEndpoint: ENDPOINT,
    ratingCount: total > 0 ? total : null,
    avgRating,
    distributionJson: JSON.stringify({ up: totalUp, down: totalDown, rollup_type: rollupType }),
    windowLabel: "ltd",
    isNativeWindow: true,
    skuCount: 1,                             // Steam appid is atomic; edition SKUs are separate appids handled at map layer
    rawJson: JSON.stringify({ rollup_type: rollupType, recent_len: recent.length, rollups_len: rollups.length }),
  };

  return { snapshot, buckets };
}

/**
 * Batch — fetch many titles serially with a small delay to be polite. Returns
 * separate ok / failed arrays so a single bad appid never fails the whole run.
 * The runner is responsible for consulting platform_sku_map.business_model
 * BEFORE calling this — F2P titles must not enter the pipeline.
 */
export async function collectSteamSignals(inputs: SteamCollectorInput[], delayMs: number = 250): Promise<CollectorResult<SteamCollectorOutput>> {
  const ok: SteamCollectorOutput[] = [];
  const failed: CollectorFailure[] = [];
  for (const inp of inputs) {
    try {
      const out = await fetchSteamRatingSignal(inp);
      ok.push(out);
    } catch (e) {
      failed.push({
        platform: "steam",
        externalSku: inp.appId,
        reason: e instanceof Error ? e.message : String(e),
        cause: e,
      });
    }
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }
  return { ok, failed };
}
