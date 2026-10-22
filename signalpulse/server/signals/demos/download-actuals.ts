import { rawSqlite, storage } from "../../storage";
import { DEMO_ACTUAL_WINDOWS, fetchDemoDownloadReports, type ActualWindow } from "./download-report";
import { recordDownloadObservation } from "./history-schema";

interface RefreshResult { attempted: number; succeeded: number; failed: number; rowsWritten: number }
let inFlight: Promise<RefreshResult> | null = null;

/** Only verified Saber game-demo App IDs, never parent-game App IDs.
 * Availability retirement does not stop verified demo report collection.
 * Dedicated cache; no writes to paid sales or demo leaderboard estimates.
 */
export function refreshDashboardDemoActuals(): Promise<RefreshResult> {
  if (inFlight) return inFlight;
  inFlight = refresh().finally(() => { inFlight = null; });
  return inFlight;
}

async function refresh(): Promise<RefreshResult> {
  const result = { attempted: 0, succeeded: 0, failed: 0, rowsWritten: 0 };
  const session = storage.getSteamworksSession("default");
  // DB-driven (2026-10-22): every Saber-published demo title -- roster-seeded
  // or publisher-flagged by hub discovery -- is collected without a code
  // change. The roster remains the curated seed, not the iteration source.
  const demos = rawSqlite.prepare(
    `SELECT steam_app_id, name FROM demo_titles
     WHERE is_saber_published = 1 AND sku_kind = 'demo' AND tracking_excluded_reason IS NULL`
  ).all() as Array<{ steam_app_id: string; name: string }>;
  for (const demo of demos) {
    const windows: readonly ActualWindow[] = DEMO_ACTUAL_WINDOWS;
    result.attempted++;
    const attemptedAt = new Date().toISOString();
    const recordFailure = (window: ActualWindow) => {
      rawSqlite.prepare(`INSERT INTO demo_download_actuals (steam_app_id,window,last_attempt_at,last_error)
        VALUES (?,?,?,'Steamworks download report unavailable or unverified')
        ON CONFLICT(steam_app_id,window) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_error=excluded.last_error`)
        .run(demo.steam_app_id, window, attemptedAt);
    };
    try {
      if (!session?.cookieValue) throw Error("Steamworks session unavailable");
      const { reports, failures } = await fetchDemoDownloadReports(demo.steam_app_id, demo.name, session.cookieValue, windows);
      for (const report of reports) {
        rawSqlite.transaction(() => {
          rawSqlite.prepare(`INSERT INTO demo_download_actuals
          (steam_app_id,window,downloads,report_start_date,report_end_date,fetched_at,source_url,source,last_attempt_at,last_error)
          VALUES (?,?,?,?,?,?,?,'steamworks_downloads_report',?,NULL)
          ON CONFLICT(steam_app_id,window) DO UPDATE SET
            downloads=excluded.downloads,report_start_date=excluded.report_start_date,report_end_date=excluded.report_end_date,
            fetched_at=excluded.fetched_at,source_url=excluded.source_url,source=excluded.source,
            last_attempt_at=excluded.last_attempt_at,last_error=NULL`)
          .run(demo.steam_app_id, report.window, report.downloads, report.reportStartDate, report.reportEndDate, report.fetchedAt, report.sourceUrl, attemptedAt);
          recordDownloadObservation(rawSqlite, demo.steam_app_id, report);
        })();
        result.rowsWritten++;
      }
      failures.forEach(recordFailure);
      if (failures.length) result.failed++;
      else result.succeeded++;
    } catch {
      // No raw upstream content, cookie, redirect URLs or tokens in logs/DB.
      // Keep last good actual (including 0); signal failed refresh separately.
      windows.forEach(recordFailure);
      result.failed++;
    }
  }
  return result;
}
