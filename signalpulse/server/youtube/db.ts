/**
 * YouTube Pulse — dedicated SQLite database (v1.0, 2026-09-24).
 *
 * Separate from SignalPulse's `data.db` for source provenance and backups.
 * Owner-requested permanent retention: video records, daily snapshots and
 * comment text have no age-based erasure. Relevance failures and upstream
 * removals are exclusions, not deletes. Only rejected-search caches expire.
 * This application setting is not a determination about API policy rights.
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
    required_terms TEXT NOT NULL DEFAULT '[]',
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
    relevance_version INTEGER NOT NULL DEFAULT 0,
    excluded_at TEXT,
    exclusion_reason TEXT,
    discovered_via TEXT NOT NULL,     -- incremental | backfill | manual
    first_seen_at TEXT NOT NULL,
    last_refreshed_at TEXT NOT NULL,
    comments_disabled INTEGER NOT NULL DEFAULT 0,
    comments_newest_at TEXT,          -- newest top-level comment publishedAt stored
    comments_backfill_token TEXT,     -- pageToken to continue an older-comment backfill
    comments_backfill_done INTEGER NOT NULL DEFAULT 0,
    comments_polled_at TEXT,
    comments_count_at_poll INTEGER,
    comments_incremental_token TEXT,
    comments_incremental_newest TEXT,
    comments_backfill_polled_at TEXT
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
    fetched_at TEXT NOT NULL,         -- last time the text was fetched/refreshed from the API
    excluded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS yt_comments_fetched ON yt_comments(fetched_at, comment_id);
  CREATE INDEX IF NOT EXISTS yt_comments_video ON yt_comments(video_id);
  CREATE TABLE IF NOT EXISTS yt_reply_cursors (
    parent_id TEXT PRIMARY KEY,
    page_token TEXT
  );

  -- Search candidates that failed relevance, so they are not re-fetched daily.
  -- Rejected-candidate cache only: expire after 30 days to permit re-evaluation.
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
  // Additive upgrade of the draft v1 database; rows remain quarantined until
  // the stats pass re-fetches metadata and validates against the new rules.
  const titleCols = new Set((db.prepare("PRAGMA table_info(yt_titles)").all() as any[]).map(c => c.name));
  if (!titleCols.has("required_terms")) db.exec("ALTER TABLE yt_titles ADD COLUMN required_terms TEXT NOT NULL DEFAULT '[]'");
  const videoCols = new Set((db.prepare("PRAGMA table_info(yt_videos)").all() as any[]).map(c => c.name));
  if (!videoCols.has("relevance_version")) db.exec("ALTER TABLE yt_videos ADD COLUMN relevance_version INTEGER NOT NULL DEFAULT 0");
  if (!videoCols.has("excluded_at")) db.exec("ALTER TABLE yt_videos ADD COLUMN excluded_at TEXT");
  if (!videoCols.has("exclusion_reason")) db.exec("ALTER TABLE yt_videos ADD COLUMN exclusion_reason TEXT");
  if (!videoCols.has("comments_incremental_token")) db.exec("ALTER TABLE yt_videos ADD COLUMN comments_incremental_token TEXT");
  if (!videoCols.has("comments_incremental_newest")) db.exec("ALTER TABLE yt_videos ADD COLUMN comments_incremental_newest TEXT");
  if (!videoCols.has("comments_backfill_polled_at")) db.exec("ALTER TABLE yt_videos ADD COLUMN comments_backfill_polled_at TEXT");
  const commentCols = new Set((db.prepare("PRAGMA table_info(yt_comments)").all() as any[]).map(c => c.name));
  if (!commentCols.has("excluded_at")) db.exec("ALTER TABLE yt_comments ADD COLUMN excluded_at TEXT");
  return db;
}

let _db: YtDb | null = null;
export function ytDb(): YtDb {
  if (!_db) _db = openYoutubeDb();
  return _db;
}
/** Test hook: swap in an in-memory database. */
export function setYtDbForTests(db: YtDb | null) { _db = db; }
