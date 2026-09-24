/**
 * YouTube Pulse — dedicated SQLite database (v1.0, 2026-09-24).
 *
 * Deliberately separate from SignalPulse's `data.db`: YouTube API Data has
 * its own retention rules (YouTube API Services Developer Policies III.E.4)
 * and must never be blended with Steam/console data. Keeping it in its own
 * file makes the 30-day refresh/delete obligations auditable and lets the
 * whole surface be dropped without touching SignalPulse tables.
 *
 * Retention (enforced by retention.ts, not by the schema):
 *   - yt_videos metadata + current statistics: refreshed daily; any row not
 *     refreshed for 30 days is deleted.
 *   - yt_video_stats_daily snapshots: kept 30 days, or 36 months once the
 *     `youtube_extended_storage_approved` app setting is "true" (only after
 *     YouTube accepts the derived-metrics / storage amendment).
 *   - yt_comments text: refreshed or deleted before 30 days, in every case.
 *
 * Path: YOUTUBE_DB_PATH env or `youtube.db` next to data.db (process cwd).
 */
import Database from "better-sqlite3";

export type YtDb = Database.Database;

export const YOUTUBE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS yt_titles (
    title_id INTEGER PRIMARY KEY,     -- = primary Steam app id (shared key with SentimentPulse games)
    title TEXT NOT NULL,
    steam_app_id TEXT,
    is_saber INTEGER NOT NULL DEFAULT 1,       -- 0 = competitor under a SentimentPulse parent title
    parent_title_id INTEGER,                   -- Steam app id of the Saber parent (competitors only)
    sentimentpulse_game_id INTEGER,            -- games.id in SentimentPulse (NULL when not tracked there)
    signalpulse_product_id INTEGER,            -- products.id in SignalPulse (NULL when not a product)
    title_source TEXT NOT NULL DEFAULT 'signalpulse', -- sentimentpulse | signalpulse | both
    search_query TEXT NOT NULL,
    phrases TEXT NOT NULL,            -- JSON string[]; one must appear in the video title
    exclude_terms TEXT NOT NULL,      -- JSON string[]; any hit in title/description rejects
    title_excludes TEXT NOT NULL DEFAULT '[]', -- JSON string[]; longer phrases of other titles (title-only check)
    require_companion INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    backfill_floor TEXT NOT NULL,     -- ISO date; discovery never searches before this
    backfill_oldest TEXT,             -- ISO datetime; oldest publishedAfter slice fully searched
    last_incremental_at TEXT,         -- ISO datetime of the last successful incremental search
    backfill_slice_days INTEGER NOT NULL DEFAULT 30,
    config_source TEXT NOT NULL DEFAULT 'seed',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS yt_videos (
    video_id TEXT PRIMARY KEY,
    title_id INTEGER NOT NULL,
    channel_id TEXT,
    channel_title TEXT,
    title TEXT NOT NULL,
    published_at TEXT NOT NULL,
    duration_s INTEGER,
    is_short_form INTEGER NOT NULL DEFAULT 0,
    live_broadcast TEXT,
    category_id TEXT,
    thumbnail_url TEXT,
    view_count INTEGER,
    like_count INTEGER,               -- NULL when the uploader hides likes
    comment_count INTEGER,            -- NULL when comments are disabled
    match_reason TEXT NOT NULL,
    discovered_via TEXT NOT NULL,     -- incremental | backfill | manual
    first_seen_at TEXT NOT NULL,
    last_refreshed_at TEXT NOT NULL,
    comments_disabled INTEGER NOT NULL DEFAULT 0,
    comments_newest_at TEXT,          -- newest top-level comment publishedAt stored
    comments_backfill_token TEXT,     -- pageToken to continue an older-comment backfill
    comments_backfill_done INTEGER NOT NULL DEFAULT 0,
    comments_polled_at TEXT,
    comments_count_at_poll INTEGER
  );
  CREATE INDEX IF NOT EXISTS yt_videos_product_pub ON yt_videos(title_id, published_at);

  CREATE TABLE IF NOT EXISTS yt_video_stats_daily (
    video_id TEXT NOT NULL,
    date TEXT NOT NULL,               -- UTC date of the snapshot
    view_count INTEGER,
    like_count INTEGER,
    comment_count INTEGER,
    PRIMARY KEY (video_id, date)
  );
  CREATE INDEX IF NOT EXISTS yt_stats_date ON yt_video_stats_daily(date);

  CREATE TABLE IF NOT EXISTS yt_comments (
    comment_id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    title_id INTEGER NOT NULL,
    parent_id TEXT,                   -- NULL for top-level comments
    author_channel_id TEXT,
    text TEXT NOT NULL,
    like_count INTEGER,
    published_at TEXT NOT NULL,
    updated_at TEXT,
    fetched_at TEXT NOT NULL          -- last time the text was fetched/refreshed from the API
  );
  CREATE INDEX IF NOT EXISTS yt_comments_fetched ON yt_comments(fetched_at, comment_id);
  CREATE INDEX IF NOT EXISTS yt_comments_video ON yt_comments(video_id);

  -- Search candidates that failed relevance, so they are not re-fetched daily.
  -- API data: purged after 30 days like everything else.
  CREATE TABLE IF NOT EXISTS yt_rejected_videos (
    video_id TEXT NOT NULL,
    title_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (video_id, title_id)
  );

  CREATE TABLE IF NOT EXISTS yt_comment_tombstones (
    comment_id TEXT PRIMARY KEY,
    title_id INTEGER,
    reason TEXT NOT NULL,
    deleted_at TEXT NOT NULL
  );

  -- One-off competitor lookups (search box). Cached so repeat lookups do not
  -- spend search quota; nothing here feeds the leaderboard or comment feed.
  CREATE TABLE IF NOT EXISTS yt_lookups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_norm TEXT NOT NULL,
    query TEXT NOT NULL,
    strict INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    result_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS yt_lookups_q ON yt_lookups(query_norm, strict, created_at);

  CREATE TABLE IF NOT EXISTS yt_quota_daily (
    pt_date TEXT NOT NULL,            -- quota day in America/Los_Angeles
    bucket TEXT NOT NULL,             -- search | units
    used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (pt_date, bucket)
  );

  CREATE TABLE IF NOT EXISTS yt_ingest_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,             -- running | success | partial | failed | skipped
    search_calls INTEGER NOT NULL DEFAULT 0,
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

export function openYoutubeDb(path = process.env.YOUTUBE_DB_PATH || "youtube.db"): YtDb {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(YOUTUBE_SCHEMA_SQL);
  return db;
}

let _db: YtDb | null = null;
export function ytDb(): YtDb {
  if (!_db) _db = openYoutubeDb();
  return _db;
}
/** Test hook: swap in an in-memory database. */
export function setYtDbForTests(db: YtDb | null) { _db = db; }
