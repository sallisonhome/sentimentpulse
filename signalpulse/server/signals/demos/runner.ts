/**
 * Steam Demos leaderboard — review-history collector runner.
 *
 * Reuses the existing, portable `fetchSteamRatingSignal` collector from
 * signals/console/steam.ts (appreviewhistogram) unchanged. Deliberately
 * does NOT go through signals/console/runner.ts, because that runner's
 * insertStoreRatingSnapshot() write path is gated on
 * platform_sku_map.business_model === 'paid' (the F2P-exclusion rule) —
 * demos are free by definition, so routing through that path would mean
 * every demo silently gets gated out, or (worse) require weakening a gate
 * that exists specifically to keep free-to-play titles out of paid-title
 * revenue reporting. Demos get their own runner and their own tables
 * (demo_titles, demo_window_estimates_daily) instead.
 *
 * steam_review_history itself IS reused as-is: it's keyed on app_id with
 * no FK into products, and the insert here is decoupled from the F2P gate
 * (confirmed by reading runner.ts — insertSteamBucket() has no gate check
 * of its own; the gate only wraps insertStoreRatingSnapshot()).
 */

import { rawSqlite } from "../../storage";
import { log } from "../../log";
import { fetchSteamRatingSignal, type SteamCollectorInput } from "../console/steam";
import { recordReviewObservation } from "./history-schema";
import { loadDemoCatalog } from "./catalog";

const insertSteamBucketStmt = () => rawSqlite.prepare(
  `INSERT INTO steam_review_history
     (app_id, bucket_start, bucket_granularity, recommendations_up, recommendations_down,
      source_endpoint, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(app_id, bucket_start, bucket_granularity) DO UPDATE SET
     recommendations_up = excluded.recommendations_up,
     recommendations_down = excluded.recommendations_down,
     source_endpoint = excluded.source_endpoint,
     created_at = excluded.created_at`
);

const markCheckedStmt = () => rawSqlite.prepare(
  `UPDATE demo_titles SET last_checked_at = ?, updated_at = ? WHERE id = ?`
);

export interface DemoTitleRow {
  id: number;
  steam_app_id: string;
  name: string;
  is_active?: number;
}

export function loadActiveDemoTitles(includePasses = false): DemoTitleRow[] {
  return rawSqlite
    .prepare(`SELECT id, steam_app_id, name FROM demo_titles WHERE is_active = 1 ${includePasses ? "" : "AND sku_kind='demo'"}`)
    .all() as DemoTitleRow[];
}

export interface DemosRunResult {
  attempted: number;
  ingested: number;
  deactivated: number;
  failed: number;
  failureSample: Array<{ appId: string; reason: string }>;
  succeededAppIds: string[];
}

/**
 * Fetch and store review-history buckets for tracked demos, including
 * retired ones. Failed/zeroed retired responses retain last-good evidence;
 * they never change availability or refresh an estimate's observation date.
 */
export async function runDemosReviewHistoryCollector(delayMs = 250, eligibleAppIds?: ReadonlySet<string>): Promise<DemosRunResult> {
  const demos = [...loadDemoCatalog("demo"),...(eligibleAppIds?loadDemoCatalog("friends_pass"):[])]
    .filter(d => !eligibleAppIds || eligibleAppIds.has(d.steam_app_id));
  const result: DemosRunResult = { attempted: demos.length, ingested: 0, deactivated: 0, failed: 0, failureSample: [],succeededAppIds:[] };
  const nowIso = new Date().toISOString();

  for (const demo of demos) {
    const input: SteamCollectorInput = { titleId: demo.id, appId: demo.steam_app_id };
    try {
      const out = await fetchSteamRatingSignal(input);
      if (!out.buckets.length || out.buckets.some(b=>![b.recommendationsUp,b.recommendationsDown]
        .every(n=>Number.isSafeInteger(n)&&n>=0))) throw Error("Review histogram unavailable or invalid");
      // Delisted apps may return HTTP 200 with every historic bucket zeroed.
      // That is not evidence that previously observed reviews disappeared.
      const previousPositive=rawSqlite.prepare(`SELECT 1 FROM steam_review_history
        WHERE app_id=? AND recommendations_up+recommendations_down>0 LIMIT 1`).get(demo.steam_app_id)||
        rawSqlite.prepare(`SELECT 1 FROM demo_window_estimates_daily
          WHERE demo_title_id=? AND review_count_total>0 LIMIT 1`).get(demo.id);
      if(demo.is_active!==1&&previousPositive&&out.buckets.every(b=>b.recommendationsUp+b.recommendationsDown===0))
        throw Error("Retired demo returned an empty replacement histogram; retained last good reviews");
      rawSqlite.transaction(() => {
        for (const b of out.buckets) {
          insertSteamBucketStmt().run(
            b.appId, b.bucketStart, b.bucketGranularity,
            b.recommendationsUp, b.recommendationsDown, b.sourceEndpoint, nowIso,
          );
        }
        // Only a real lifetime rollup can establish a cumulative observation.
        // Recent-only daily buckets must not masquerade as lifetime reviews.
        const evidence = JSON.parse(out.snapshot.rawJson ?? "{}");
        const distribution = JSON.parse(out.snapshot.distributionJson ?? "{}");
        if (evidence.rollups_len > 0) recordReviewObservation(rawSqlite, demo.steam_app_id,
          distribution.up, distribution.down, new Date().toISOString());
      })();
      markCheckedStmt().run(nowIso, nowIso, demo.id);
      result.ingested += 1;
      result.succeededAppIds.push(demo.steam_app_id);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // Review availability is not storefront availability. Keep last good
      // buckets and retry at the normal next daily run.
      result.failed += 1;
      if (result.failureSample.length < 5) result.failureSample.push({ appId: demo.steam_app_id, reason });
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  log(
    `demos review-history run: attempted=${result.attempted} ingested=${result.ingested} deactivated=${result.deactivated} failed=${result.failed}`,
    "demos-runner",
  );
  return result;
}
