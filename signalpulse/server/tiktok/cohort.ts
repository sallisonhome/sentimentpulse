/**
 * TikTok Pulse — cohort leaderboard (default view).
 *
 * Cohort definition (mirrors YouTube Pulse): for each window, the cohort is
 * the set of tracked videos PUBLISHED (create_time) inside the window; every
 * metric is the sum of those videos' CURRENT lifetime statistics as last
 * returned by the API. No stored history is required, so all six windows
 * are valid from day one.
 *
 * "Views gained in the window" (velocity) is a different metric and is not
 * computed here.
 *
 * Likes % of views is a SignalPulse calculation (Σlikes ÷ Σviews). TikTok
 * posts don't hide likes, so there's no `likesHiddenVideos` equivalent.
 * Short-form is trivially all TikTok posts.
 */
import type { TtDb } from "./db";
import { RELEVANCE_VERSION } from "./relevance";

export const COHORT_WINDOWS = ["d1", "d7", "d30", "d90", "m12", "ltd"] as const;
export type CohortWindow = typeof COHORT_WINDOWS[number];
export const WINDOW_HOURS: Record<CohortWindow, number | null> = {
  d1: 24, d7: 24 * 7, d30: 24 * 30, d90: 24 * 90, m12: 24 * 365, ltd: null,
};

export const COHORT_SORTS = ["views", "videos", "comments", "likes", "likesPct", "reposts", "title"] as const;
export type CohortSort = typeof COHORT_SORTS[number];

export interface CohortTopVideo {
  awemeId: string; desc: string; authorUniqueId: string | null; views: number;
  createTime: number; url: string;
}

export interface CohortRow {
  titleId: number;
  title: string;
  steamAppId: string | null;
  isSaber: boolean;
  parentTitle: string | null;
  views: number;
  videos: number;
  comments: number;
  likes: number;
  reposts: number;
  likesPct: number | null;
  topVideo: CohortTopVideo | null;
  statsAsOf: string | null;
  trackingSince: string | null;
  backfillComplete: boolean;
  backfillOldest: string | null;
  backfillFloor: string;
}

export function windowStart(w: CohortWindow, now = new Date()): number | null {
  const h = WINDOW_HOURS[w];
  if (h == null) return null;
  // d1 is a UTC calendar-day window anchored to the last completed cron
  // run, not a rolling 24 hours from "now". This makes the 24-hour numbers
  // stable: they only change when the next cron runs, not when someone
  // visits the page. For d7/d30/d90/m12 we keep the rolling window
  // (longer windows are less sensitive to visit timing).
  if (w === "d1") {
    const todayUtc = now.toISOString().slice(0, 10);
    return Math.floor(Date.parse(`${todayUtc}T00:00:00.000Z`) / 1000);
  }
  return Math.floor((now.getTime() - h * 3600_000) / 1000);
}

export function computeCohortLeaderboard(db: TtDb, w: CohortWindow, sort: CohortSort = "views",
  direction: "asc" | "desc" = "desc", now = new Date(), scope: "saber" | "all" = "saber"): CohortRow[] {
  const start = windowStart(w, now);
  const titles = db.prepare(`SELECT t.*, p.title AS parent_title FROM tt_titles t
    LEFT JOIN tt_titles p ON p.title_id=t.parent_title_id
    WHERE t.enabled=1 AND (? = 'all' OR t.is_saber=1)`).all(scope) as any[];
  const agg = db.prepare(`
    SELECT title_id,
      COUNT(*) AS videos,
      COALESCE(SUM(view_count),0) AS views,
      COALESCE(SUM(comment_count),0) AS comments,
      COALESCE(SUM(like_count),0) AS likes,
      COALESCE(SUM(repost_count),0) AS reposts,
      COALESCE(SUM(CASE WHEN like_count IS NOT NULL THEN view_count END),0) AS views_with_likes,
      MIN(last_refreshed_at) AS stats_as_of
    FROM tt_videos
    WHERE excluded_at IS NULL AND relevance_version=${RELEVANCE_VERSION} AND (? IS NULL OR create_time >= ?)
    GROUP BY title_id`).all(start, start) as any[];
  const byId = new Map(agg.map((a) => [a.title_id, a]));
  const firstSeen = new Map((db.prepare("SELECT title_id, MIN(first_seen_at) AS s FROM tt_videos GROUP BY title_id").all() as any[]).map((r) => [r.title_id, r.s]));
  const topStmt = db.prepare(`SELECT aweme_id, desc, author_unique_id, view_count, create_time FROM tt_videos
    WHERE excluded_at IS NULL AND relevance_version=${RELEVANCE_VERSION} AND title_id=? AND (? IS NULL OR create_time >= ?)
    ORDER BY view_count DESC, create_time DESC LIMIT 1`);

  const rows: CohortRow[] = titles.map((t) => {
    const a = byId.get(t.title_id);
    const top = a ? topStmt.get(t.title_id, start, start) as any : null;
    const floorIso = `${t.backfill_floor}T00:00:00.000Z`;
    return {
      titleId: t.title_id, title: t.title, steamAppId: t.steam_app_id,
      isSaber: !!t.is_saber, parentTitle: t.parent_title ?? null,
      views: a?.views ?? 0, videos: a?.videos ?? 0,
      comments: a?.comments ?? 0, likes: a?.likes ?? 0, reposts: a?.reposts ?? 0,
      likesPct: a && a.views_with_likes > 0 ? (a.likes / a.views_with_likes) * 100 : null,
      topVideo: top ? {
        awemeId: top.aweme_id, desc: top.desc, authorUniqueId: top.author_unique_id,
        views: top.view_count ?? 0, createTime: top.create_time,
        url: `https://www.tiktok.com/@${top.author_unique_id ?? "unknown"}/video/${top.aweme_id}`,
      } : null,
      statsAsOf: a?.stats_as_of ?? null,
      trackingSince: firstSeen.get(t.title_id) ?? null,
      backfillComplete: !!t.backfill_oldest && t.backfill_oldest <= floorIso,
      backfillOldest: t.backfill_oldest, backfillFloor: t.backfill_floor,
    };
  });

  const dir = direction === "asc" ? 1 : -1;
  const val = (r: CohortRow): number | string | null => sort === "title" ? r.title.toLowerCase() : (r as any)[sort];
  rows.sort((x, y) => {
    const a = val(x), b = val(y);
    if (a == null && b == null) return x.title.localeCompare(y.title);
    if (a == null) return 1;
    if (b == null) return -1;
    if (a < b) return -1 * dir;
    if (a > b) return 1 * dir;
    return y.views - x.views || x.title.localeCompare(y.title);
  });
  return rows;
}

export function listTitleVideos(db: TtDb, titleId: number, w: CohortWindow, limit = 100, now = new Date()) {
  const start = windowStart(w, now);
  return (db.prepare(`SELECT aweme_id, author_unique_id, desc, create_time, duration_s,
      view_count, like_count, comment_count, share_count, repost_count, last_refreshed_at, match_reason
    FROM tt_videos WHERE excluded_at IS NULL AND relevance_version=${RELEVANCE_VERSION} AND title_id=? AND (? IS NULL OR create_time >= ?)
    ORDER BY view_count DESC, create_time DESC LIMIT ?`).all(titleId, start, start, limit) as any[]).map((v) => ({
    awemeId: v.aweme_id,
    url: `https://www.tiktok.com/@${v.author_unique_id ?? "unknown"}/video/${v.aweme_id}`,
    desc: v.desc, authorUniqueId: v.author_unique_id,
    createTime: v.create_time, durationS: v.duration_s,
    views: v.view_count, likes: v.like_count, comments: v.comment_count,
    shares: v.share_count, reposts: v.repost_count,
    statsAsOf: v.last_refreshed_at, matchReason: v.match_reason,
  }));
}
