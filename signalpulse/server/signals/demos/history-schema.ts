import type Database from "better-sqlite3";

/** Additive migration. Capture dates are observations, not reconstructed history. */
export function initializeDemoHistory(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS demo_download_observations (
      steam_app_id TEXT NOT NULL, window TEXT NOT NULL, observation_date TEXT NOT NULL,
      downloads INTEGER NOT NULL CHECK(downloads>=0),
      report_start_date TEXT NOT NULL, report_end_date TEXT NOT NULL,
      fetched_at TEXT NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY(steam_app_id,window,observation_date)
    );
    CREATE TABLE IF NOT EXISTS demo_review_observations (
      steam_app_id TEXT NOT NULL, observation_date TEXT NOT NULL,
      positive INTEGER NOT NULL CHECK(positive>=0),
      negative INTEGER NOT NULL CHECK(negative>=0),
      fetched_at TEXT NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY(steam_app_id,observation_date)
    );
    CREATE TABLE IF NOT EXISTS demo_media_cache (
      steam_app_id TEXT PRIMARY KEY, payload TEXT,
      fetched_at TEXT, last_attempt_at TEXT NOT NULL, status TEXT NOT NULL
    );
  `);
  // Only the last genuinely observed report can be recovered from the old
  // latest-only cache. Never seed historical dates or replace newer evidence.
  db.exec(`INSERT OR IGNORE INTO demo_download_observations
    SELECT steam_app_id,window,substr(fetched_at,1,10),downloads,
      report_start_date,report_end_date,fetched_at,source
    FROM demo_download_actuals WHERE downloads IS NOT NULL
      AND source='steamworks_downloads_report'
      AND date(fetched_at) IS NOT NULL
      AND date(report_start_date) IS NOT NULL AND date(report_end_date) IS NOT NULL`);
}

export function recordDownloadObservation(db: Database.Database, appId: string, report: {
  window: string; downloads: number; reportStartDate: string;
  reportEndDate: string; fetchedAt: string;
}) {
  db.prepare(`INSERT INTO demo_download_observations VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(steam_app_id,window,observation_date) DO UPDATE SET
      downloads=excluded.downloads,report_start_date=excluded.report_start_date,
      report_end_date=excluded.report_end_date,fetched_at=excluded.fetched_at,source=excluded.source
    WHERE excluded.fetched_at>=demo_download_observations.fetched_at`)
    .run(appId,report.window,report.fetchedAt.slice(0,10),report.downloads,
      report.reportStartDate,report.reportEndDate,report.fetchedAt,"steamworks_downloads_report");
}

export function recordReviewObservation(db: Database.Database, appId: string, positive: number, negative: number, fetchedAt: string) {
  if (![positive,negative].every(n=>Number.isSafeInteger(n)&&n>=0)) return;
  db.prepare(`INSERT INTO demo_review_observations VALUES(?,?,?,?,?,?)
    ON CONFLICT(steam_app_id,observation_date) DO UPDATE SET
      positive=excluded.positive,negative=excluded.negative,fetched_at=excluded.fetched_at,source=excluded.source
    WHERE excluded.fetched_at>=demo_review_observations.fetched_at`)
    .run(appId,fetchedAt.slice(0,10),positive,negative,fetchedAt,"steam:appreviewhistogram");
}
