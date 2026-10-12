/**
 * TikTok Pulse — dedicated SQLite database (v1.0, 2026-10-12).
 *
 * Mirrors the YouTube Pulse DB. Separate from SignalPulse's `data.db` for
 * source provenance and backups. Permanent retention: video records, daily
 * snapshots and comment text have no age-based erasure. Relevance failures
 * are exclusions, not deletes. Only rejected-search caches expire.
 *
 * Path: TIKTOK_DB_PATH env or `tiktok.db` next to data.db (process cwd).
 */
import Database from "better-sqlite3";
import { applyCollectionExclusions } from "./titles";

export type TtDb = Database.Database;

export const TIKTOK_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tt_titles (
    title_id INTEGER PRIMARY KEY,     -- = primary Steam app id (shared key with SentimentPulse games)
    title TEXT NOT NULL,
    steam_app_id TEXT,
    is_saber INTEGER NOT NULL DEFAULT 1,
    parent_title_id INTEGER,
    sentimentpulse_game_id INTEGER,
    signalpulse_product_id INTEGER,
    title_source TEXT NOT NULL DEFAULT 'signalpulse',
    hashtags TEXT NOT NULL DEFAULT '[]',     -- JSON string[]; EnsembleData /tt/hashtag/posts discovery slugs
    keywords TEXT NOT NULL DEFAULT '[]',    -- JSON string[]; EnsembleData /tt/keyword/search phrases
    phrases TEXT NOT NULL,
    exclude_terms TEXT NOT NULL DEFAULT '[]',
    title_excludes TEXT NOT NULL DEFAULT '[]',
    required_terms TEXT NOT NULL DEFAULT '[]',
    require_companion INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    backfill_floor TEXT NOT NULL,
    backfill_oldest TEXT,
    last_incremental_at TEXT,
    config_source TEXT NOT NULL DEFAULT 'seed',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tt_videos (
    aweme_id TEXT PRIMARY KEY,
    title_id INTEGER NOT NULL,
    author_unique_id TEXT,
    author_nickname TEXT,
    desc TEXT NOT NULL,
    create_time INTEGER NOT NULL,   -- epoch seconds
    duration_s INTEGER,
    view_count INTEGER,
    like_count INTEGER,
    comment_count INTEGER,
    share_count INTEGER,
    download_count INTEGER,
    repost_count INTEGER,
    forward_count INTEGER,
    collect_count INTEGER,
    match_reason TEXT NOT NULL,
    relevance_version INTEGER NOT NULL DEFAULT 0,
    excluded_at TEXT,
    exclusion_reason TEXT,
    discovered_via TEXT NOT NULL,   -- hashtag | keyword | manual
    discovered_hashtag TEXT,
    first_seen_at TEXT NOT NULL,
    last_refreshed_at TEXT NOT NULL,
    comments_polled_at TEXT,
    comments_count_at_poll INTEGER,
    comments_newest_at TEXT,
    comments_incremental_cursor INTEGER,
    comments_backfill_done INTEGER NOT NULL DEFAULT 0,
    comments_backfill_cursor INTEGER
  );
  CREATE INDEX IF NOT EXISTS tt_videos_title_create ON tt_videos(title_id, create_time);
  CREATE INDEX IF NOT EXISTS tt_videos_title_excl ON tt_videos(title_id, excluded_at);

  CREATE TABLE IF NOT EXISTS tt_video_stats_daily (
    aweme_id TEXT NOT NULL,
    date TEXT NOT NULL,               -- UTC date of the snapshot
    view_count INTEGER,
    like_count INTEGER,
    comment_count INTEGER,
    share_count INTEGER,
    repost_count INTEGER,
    download_count INTEGER,
    PRIMARY KEY (aweme_id, date)
  );
  CREATE INDEX IF NOT EXISTS tt_stats_date ON tt_video_stats_daily(date);

  CREATE TABLE IF NOT EXISTS tt_comments (
    cid TEXT PRIMARY KEY,
    aweme_id TEXT NOT NULL,
    title_id INTEGER NOT NULL,
    parent_id TEXT,                   -- reply_id; NULL for top-level
    author_unique_id TEXT,
    text TEXT NOT NULL,
    like_count INTEGER,
    create_time INTEGER NOT NULL,    -- epoch seconds
    is_author_digged INTEGER,
    reply_comment_total INTEGER,
    fetched_at TEXT NOT NULL,
    excluded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS tt_comments_fetched ON tt_comments(fetched_at, cid);
  CREATE INDEX IF NOT EXISTS tt_comments_video ON tt_comments(aweme_id);
  CREATE INDEX IF NOT EXISTS tt_comments_title ON tt_comments(title_id, create_time);

  -- Rejected discovery candidates; expire after 30 days to permit re-evaluation.
  CREATE TABLE IF NOT EXISTS tt_rejected_videos (
    aweme_id TEXT NOT NULL,
    title_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (aweme_id, title_id)
  );

  CREATE TABLE IF NOT EXISTS tt_comment_tombstones (
    cid TEXT PRIMARY KEY,
    title_id INTEGER,
    aweme_id TEXT,
    reason TEXT NOT NULL,
    deleted_at TEXT NOT NULL
  );

  -- Unit-accounting. EnsembleData resets at 00:00 UTC; failed calls caused by
  -- internal errors are not charged. Track observed usage separately from API
  -- headers so we can reconcile.
  CREATE TABLE IF NOT EXISTS tt_quota_daily (
    pt_date TEXT NOT NULL,
    bucket TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (pt_date, bucket)
  );

  CREATE TABLE IF NOT EXISTS tt_ingest_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    hashtag_calls INTEGER NOT NULL DEFAULT 0,
    keyword_calls INTEGER NOT NULL DEFAULT 0,
    post_info_calls INTEGER NOT NULL DEFAULT 0,
    comment_calls INTEGER NOT NULL DEFAULT 0,
    units_used INTEGER NOT NULL DEFAULT 0,
    videos_discovered INTEGER NOT NULL DEFAULT 0,
    videos_refreshed INTEGER NOT NULL DEFAULT 0,
    videos_removed INTEGER NOT NULL DEFAULT 0,
    comments_saved INTEGER NOT NULL DEFAULT 0,
    comments_refreshed INTEGER NOT NULL DEFAULT 0,
    comments_deleted INTEGER NOT NULL DEFAULT 0,
    message TEXT
  );
`;

export function openTikTokDb(path = process.env.TIKTOK_DB_PATH || "tiktok.db"): TtDb {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(TIKTOK_SCHEMA_SQL);
  // Apply owner opt-outs on startup.
  applyCollectionExclusions(db);
  return db;
}

let _db: TtDb | null = null;
export function ttDb(): TtDb {
  if (!_db) _db = openTikTokDb();
  return _db;
}
/** Test hook: swap in an in-memory database. */
export function setTtDbForTests(db: TtDb | null) { _db = db; }
