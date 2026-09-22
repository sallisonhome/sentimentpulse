import { rawSqlite, storage } from "../../storage";
import { SABER_DEMO_ROSTER } from "./saber-seed";
import { DEMO_ACTUAL_WINDOWS, fetchDemoDownloadReports, type ActualWindow } from "./download-report";

interface RefreshResult { attempted: number; succeeded: number; failed: number; rowsWritten: number }
let inFlight: Promise<RefreshResult> | null = null;

/** Only verified Saber game-demo App IDs, never parent-game App IDs.
 * Includes retired demos, but never broadens public discovery eligibility.
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
  for (const demo of SABER_DEMO_ROSTER) {
    result.attempted++;
    const attemptedAt = new Date().toISOString();
    const recordFailure = (window: ActualWindow) => {
      rawSqlite.prepare(`INSERT INTO demo_download_actuals (steam_app_id,window,last_attempt_at,last_error)
        VALUES (?,?,?,'Steamworks download report unavailable or unverified')
        ON CONFLICT(steam_app_id,window) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_error=excluded.last_error`)
        .run(demo.steamAppId, window, attemptedAt);
    };
    try {
      if (!session?.cookieValue) throw Error("Steamworks session unavailable");
      const { reports, failures } = await fetchDemoDownloadReports(demo.steamAppId, demo.name, session.cookieValue);
      for (const report of reports) {
        rawSqlite.prepare(`INSERT INTO demo_download_actuals
          (steam_app_id,window,downloads,report_start_date,report_end_date,fetched_at,source_url,source,last_attempt_at,last_error)
          VALUES (?,?,?,?,?,?,?,'steamworks_downloads_report',?,NULL)
          ON CONFLICT(steam_app_id,window) DO UPDATE SET
            downloads=excluded.downloads,report_start_date=excluded.report_start_date,report_end_date=excluded.report_end_date,
            fetched_at=excluded.fetched_at,source_url=excluded.source_url,source=excluded.source,
            last_attempt_at=excluded.last_attempt_at,last_error=NULL`)
          .run(demo.steamAppId, report.window, report.downloads, report.reportStartDate, report.reportEndDate, report.fetchedAt, report.sourceUrl, attemptedAt);
        result.rowsWritten++;
      }
      failures.forEach(recordFailure);
      if (failures.length) result.failed++;
      else result.succeeded++;
    } catch {
      // No raw upstream content, cookie, redirect URLs or tokens in logs/DB.
      // Keep last good actual (including 0); signal failed refresh separately.
      DEMO_ACTUAL_WINDOWS.forEach(recordFailure);
      result.failed++;
    }
  }
  return result;
}
