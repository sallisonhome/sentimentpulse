/**
 * Console-leaderboard runner.
 *
 * The ONLY file in server/signals/console/ that imports SignalPulse-specific
 * modules (storage, logger). The three collectors (steam/xbox/ps) stay pure so
 * they port to howmanyareplaying by swapping this one file.
 *
 * F2P enforcement (Steve, 2026-09-10 scope note): every write to
 * store_rating_signal_daily is gated on platform_sku_map.business_model === 'paid'.
 * Rows for free_to_play / subscription_only / unknown titles are log-and-skipped.
 * The gate lives here, not in the collectors, so we can enforce it uniformly.
 */

import { rawSqlite } from "../../storage";
import { log } from "../../index";
import { collectSteamSignals, type SteamCollectorInput } from "./steam";
import { collectXboxSignals, type XboxCollectorInput } from "./xbox";
import { collectPsSignals, type PsCollectorInput } from "./ps";
import type { BusinessModel, ConsolePlatform, StoreRatingSnapshot, SteamReviewBucket } from "./types";

interface RunResult {
  startedAt: string;
  completedAt: string;
  perPlatform: {
    steam: PlatformRunResult;
    xbox: PlatformRunResult;
    ps5: PlatformRunResult;
  };
}

interface PlatformRunResult {
  attempted: number;
  ingested: number;
  gatedF2P: number;
  gatedUnknown: number;
  failed: number;
  failureSample: Array<{ sku?: string; reason: string }>;
}

interface SkuGateRow {
  title_id: number;
  external_sku: string;
  business_model: BusinessModel;
}

/**
 * Look up business_model for every candidate SKU on a platform in one query.
 * Absent = 'unknown' (gated out). We build the IN(...) placeholders inline
 * because better-sqlite3 doesn't do array binding.
 */
function loadSkuGate(platform: ConsolePlatform, skus: string[]): Map<string, SkuGateRow> {
  if (skus.length === 0) return new Map();
  const placeholders = skus.map(() => "?").join(",");
  const stmt = rawSqlite.prepare(
    `SELECT title_id, external_sku, business_model
       FROM platform_sku_map
      WHERE platform = ?
        AND external_sku IN (${placeholders})`
  );
  const rows = stmt.all(platform, ...skus) as SkuGateRow[];
  const map = new Map<string, SkuGateRow>();
  for (const r of rows) map.set(r.external_sku, r);
  return map;
}

// Cached prepared statements (better-sqlite3 handles this internally, but naming them helps readability).
const insertSnapshotStmt = () => rawSqlite.prepare(
  `INSERT INTO store_rating_signal_daily
     (title_id, platform, capture_date, source_endpoint, rating_count, avg_rating,
      distribution_json, window_label, is_native_window, sku_count, raw_json, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(title_id, platform, capture_date) DO UPDATE SET
     source_endpoint = excluded.source_endpoint,
     rating_count = excluded.rating_count,
     avg_rating = excluded.avg_rating,
     distribution_json = excluded.distribution_json,
     window_label = excluded.window_label,
     is_native_window = excluded.is_native_window,
     sku_count = excluded.sku_count,
     raw_json = excluded.raw_json`
);

const insertSteamBucketStmt = () => rawSqlite.prepare(
  `INSERT INTO steam_review_history
     (app_id, bucket_start, bucket_granularity, recommendations_up, recommendations_down,
      source_endpoint, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(app_id, bucket_start, bucket_granularity) DO UPDATE SET
     recommendations_up = excluded.recommendations_up,
     recommendations_down = excluded.recommendations_down,
     source_endpoint = excluded.source_endpoint`
);

const insertDivergenceStmt = () => rawSqlite.prepare(
  `INSERT INTO signal_source_divergence
     (capture_date, platform, title_id, endpoint_a, endpoint_b, value_a, value_b, pct_delta, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(capture_date, platform, title_id, endpoint_a, endpoint_b) DO UPDATE SET
     value_a = excluded.value_a,
     value_b = excluded.value_b,
     pct_delta = excluded.pct_delta`
);

function insertStoreRatingSnapshot(titleId: number, s: StoreRatingSnapshot) {
  const nowIso = new Date().toISOString();
  insertSnapshotStmt().run(
    titleId, s.platform, s.captureDate, s.sourceEndpoint,
    s.ratingCount, s.avgRating, s.distributionJson,
    s.windowLabel, s.isNativeWindow ? 1 : 0, s.skuCount, s.rawJson, nowIso,
  );
}

function insertSteamBucket(b: SteamReviewBucket) {
  const nowIso = new Date().toISOString();
  insertSteamBucketStmt().run(
    b.appId, b.bucketStart, b.bucketGranularity,
    b.recommendationsUp, b.recommendationsDown, b.sourceEndpoint, nowIso,
  );
}

function insertDivergence(params: {
  platform: ConsolePlatform;
  titleId: number;
  endpointA: string;
  endpointB: string;
  valueA: number | null;
  valueB: number | null;
}) {
  const nowIso = new Date().toISOString();
  const captureDate = new Date().toISOString().slice(0, 10);
  const a = params.valueA ?? 0;
  const b = params.valueB ?? 0;
  const denom = Math.max(a, b);
  const pctDelta = denom > 0 ? Math.abs(a - b) / denom : null;
  insertDivergenceStmt().run(
    captureDate, params.platform, params.titleId, params.endpointA, params.endpointB,
    params.valueA, params.valueB, pctDelta, nowIso,
  );
}

// ─── Public entry points per platform ────────────────────────────────────────

export async function runSteamCollector(inputs: SteamCollectorInput[]): Promise<PlatformRunResult> {
  const gate = loadSkuGate("steam", inputs.map(i => i.appId));
  const eligible: SteamCollectorInput[] = [];
  let gatedF2P = 0, gatedUnknown = 0;
  for (const inp of inputs) {
    const g = gate.get(inp.appId);
    if (!g) { gatedUnknown++; log(`steam gate: skipping appid=${inp.appId} — not in platform_sku_map`); continue; }
    if (g.business_model === "paid") { eligible.push({ ...inp, titleId: g.title_id }); continue; }
    if (g.business_model === "free_to_play") { gatedF2P++; log(`steam gate: skipping appid=${inp.appId} — free_to_play`); continue; }
    gatedUnknown++;
    log(`steam gate: skipping appid=${inp.appId} — business_model=${g.business_model}`);
  }

  const res = await collectSteamSignals(eligible);
  let ingested = 0;
  for (let i = 0; i < res.ok.length; i++) {
    const out = res.ok[i];
    const inp = eligible[i];
    if (!inp) continue;
    insertStoreRatingSnapshot(inp.titleId, out.snapshot);
    for (const b of out.buckets) insertSteamBucket(b);
    ingested++;
  }

  return {
    attempted: inputs.length,
    ingested,
    gatedF2P,
    gatedUnknown,
    failed: res.failed.length,
    failureSample: res.failed.slice(0, 5).map(f => ({ sku: f.externalSku, reason: f.reason })),
  };
}

export async function runXboxCollector(inputs: XboxCollectorInput[]): Promise<PlatformRunResult> {
  const gate = loadSkuGate("xbox", inputs.map(i => i.bigId));
  const eligible: XboxCollectorInput[] = [];
  let gatedF2P = 0, gatedUnknown = 0;
  for (const inp of inputs) {
    const g = gate.get(inp.bigId);
    if (!g) { gatedUnknown++; log(`xbox gate: skipping bigId=${inp.bigId} — not in platform_sku_map`); continue; }
    if (g.business_model === "paid") { eligible.push({ ...inp, titleId: g.title_id }); continue; }
    if (g.business_model === "free_to_play") { gatedF2P++; log(`xbox gate: skipping bigId=${inp.bigId} — free_to_play`); continue; }
    gatedUnknown++;
  }

  const res = await collectXboxSignals(eligible);
  let ingested = 0;
  for (let i = 0; i < res.ok.length; i++) {
    const out = res.ok[i];
    const inp = eligible[i];
    if (!inp) continue;
    // store_rating_signal_daily is unique on (title, platform, capture_date).
    // Xbox natively returns three windows; keep the LTD row on disk and bundle
    // d7/d30 numbers into raw_json for the estimator to consume.
    const ltd = out.snapshots.find(s => s.windowLabel === "ltd") ?? out.snapshots[0];
    if (!ltd) continue;
    const bundled: StoreRatingSnapshot = {
      ...ltd,
      rawJson: JSON.stringify({
        windows: out.snapshots.map(s => ({
          window: s.windowLabel,
          rating_count: s.ratingCount,
          avg_rating: s.avgRating,
        })),
      }),
    };
    insertStoreRatingSnapshot(inp.titleId, bundled);
    ingested++;
  }

  return {
    attempted: inputs.length,
    ingested,
    gatedF2P,
    gatedUnknown,
    failed: res.failed.length,
    failureSample: res.failed.slice(0, 5).map(f => ({ sku: f.externalSku, reason: f.reason })),
  };
}

export async function runPsCollector(inputs: PsCollectorInput[]): Promise<PlatformRunResult> {
  const gate = loadSkuGate("ps5", inputs.map(i => i.productId));
  const eligible: PsCollectorInput[] = [];
  let gatedF2P = 0, gatedUnknown = 0;
  for (const inp of inputs) {
    const g = gate.get(inp.productId);
    if (!g) { gatedUnknown++; log(`ps gate: skipping productId=${inp.productId} — not in platform_sku_map`); continue; }
    if (g.business_model === "paid") { eligible.push({ ...inp, titleId: g.title_id }); continue; }
    if (g.business_model === "free_to_play") { gatedF2P++; log(`ps gate: skipping productId=${inp.productId} — free_to_play`); continue; }
    gatedUnknown++;
  }

  const res = await collectPsSignals(eligible);
  let ingested = 0;
  for (let i = 0; i < res.ok.length; i++) {
    const out = res.ok[i];
    const inp = eligible[i];
    if (!inp) continue;
    insertStoreRatingSnapshot(inp.titleId, out.snapshot);
    if (out.usedFallback) {
      insertDivergence({
        platform: "ps5",
        titleId: inp.titleId,
        endpointA: "ps:wcaProductStarRatingRetrive",
        endpointB: "ps:pdp-html",
        valueA: null,
        valueB: out.snapshot.ratingCount,
      });
    }
    ingested++;
  }

  return {
    attempted: inputs.length,
    ingested,
    gatedF2P,
    gatedUnknown,
    failed: res.failed.length,
    failureSample: res.failed.slice(0, 5).map(f => ({ sku: f.externalSku, reason: f.reason })),
  };
}

/**
 * Orchestrator — one call runs all three platforms for a given input set.
 * Called by ingestion.ts on the daily cron. Safe to invoke ad-hoc via CLI.
 */
export async function runConsoleLeaderboardIngest(inputs: {
  steam: SteamCollectorInput[];
  xbox: XboxCollectorInput[];
  ps: PsCollectorInput[];
}): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const [steam, xbox, ps5] = await Promise.all([
    runSteamCollector(inputs.steam),
    runXboxCollector(inputs.xbox),
    runPsCollector(inputs.ps),
  ]);
  const completedAt = new Date().toISOString();
  return { startedAt, completedAt, perPlatform: { steam, xbox, ps5 } };
}
