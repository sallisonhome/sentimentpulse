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

const markCheckedStmt = () => rawSqlite.prepare(
  `UPDATE demo_titles SET last_checked_at = ?, updated_at = ? WHERE id = ?`
);

const markDeactivatedStmt = () => rawSqlite.prepare(
  `UPDATE demo_titles SET is_active = 0, deactivated_at = ?, last_checked_at = ?, updated_at = ? WHERE id = ?`
);

export interface DemoTitleRow {
  id: number;
  steam_app_id: string;
  name: string;
}

export function loadActiveDemoTitles(): DemoTitleRow[] {
  return rawSqlite
    .prepare(`SELECT id, steam_app_id, name FROM demo_titles WHERE is_active = 1`)
    .all() as DemoTitleRow[];
}

export interface DemosRunResult {
  attempted: number;
  ingested: number;
  deactivated: number;
  failed: number;
  failureSample: Array<{ appId: string; reason: string }>;
}

/**
 * Fetch and store review-history buckets for every active demo. A demo
 * whose histogram fetch fails with a not-successful response is treated
 * as a deactivation signal (mirrors the confirmed api/appdetails
 * success:false behavior for a deactivated demo) rather than a transient
 * failure, so it stops being polled daily once dead.
 */
export async function runDemosReviewHistoryCollector(delayMs = 250, eligibleAppIds?: ReadonlySet<string>): Promise<DemosRunResult> {
  const demos = loadActiveDemoTitles().filter(d => !eligibleAppIds || eligibleAppIds.has(d.steam_app_id));
  const result: DemosRunResult = { attempted: demos.length, ingested: 0, deactivated: 0, failed: 0, failureSample: [] };
  const nowIso = new Date().toISOString();

  for (const demo of demos) {
    const input: SteamCollectorInput = { titleId: demo.id, appId: demo.steam_app_id };
    try {
      const out = await fetchSteamRatingSignal(input);
      for (const b of out.buckets) {
        insertSteamBucketStmt().run(
          b.appId, b.bucketStart, b.bucketGranularity,
          b.recommendationsUp, b.recommendationsDown, b.sourceEndpoint, nowIso,
        );
      }
      markCheckedStmt().run(nowIso, nowIso, demo.id);
      result.ingested += 1;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // A freshly verified playable demo may not have a histogram yet.
      // Missing reviews must not remove new releases from source rankings.
      if (reason.includes("not-successful") && !eligibleAppIds?.has(demo.steam_app_id)) {
        markDeactivatedStmt().run(nowIso, nowIso, nowIso, demo.id);
        result.deactivated += 1;
      } else {
        result.failed += 1;
        if (result.failureSample.length < 5) result.failureSample.push({ appId: demo.steam_app_id, reason });
      }
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  log(
    `demos review-history run: attempted=${result.attempted} ingested=${result.ingested} deactivated=${result.deactivated} failed=${result.failed}`,
    "demos-runner",
  );
  return result;
}
