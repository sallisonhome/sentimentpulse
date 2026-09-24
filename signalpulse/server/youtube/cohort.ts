/**
 * YouTube Pulse — cohort leaderboard (default view).
 *
 * Cohort definition (decided 2026-09-24): for each window, the cohort is the
 * set of tracked videos PUBLISHED inside the window; every metric is the sum
 * of those videos' CURRENT lifetime statistics as last returned by the API.
 * No stored history is required, so all six windows are valid from day one.
 *
 * "Views gained in the window" (velocity) is a different metric and is not
 * computed here.
 *
 * Likes % of views is a SignalPulse calculation (Σlikes ÷ Σviews over videos
 * whose likes are public). Videos with hidden likes are excluded from both
 * numerator and denominator of that ratio and counted in likesHiddenVideos.
 */
import type { YtDb } from "./db";

export const COHORT_WINDOWS = ["d1", "d7", "d30", "d90", "m12", "ltd"] as const;
export type CohortWindow = typeof COHORT_WINDOWS[number];
export const WINDOW_HOURS: Record<CohortWindow, number | null> = {
  d1: 24, d7: 24 * 7, d30: 24 * 30, d90: 24 * 90, m12: 24 * 365, ltd: null,
};

export const COHORT_SORTS = ["views", "videos", "shortForm", "comments", "likes", "likesPct", "title"] as const;
export type CohortSort = typeof COHORT_SORTS[number];

export interface CohortTopVideo { videoId: string; title: string; channelTitle: string | null; views: number; publishedAt: string; isShortForm: boolean }

export interface CohortRow {
  titleId: number;
  title: string;
  steamAppId: string | null;
  isSaber: boolean;
  parentTitle: string | null;
  views: number;
  videos: number;
  shortForm: number;
  comments: number;
  likes: number;
  likesPct: number | null;
  likesHiddenVideos: number;
  commentsDisabledVideos: number;
  topVideo: CohortTopVideo | null;
  statsAsOf: string | null;
  trackingSince: string | null;
  backfillComplete: boolean;
  backfillOldest: string | null;
  backfillFloor: string;
}

export function windowStart(w: CohortWindow, now = new Date()): string | null {
  const h = WINDOW_HOURS[w];
  return h == null ? null : new Date(now.getTime() - h * 3600_000).toISOString();
}

export function computeCohortLeaderboard(db: YtDb, w: CohortWindow, sort: CohortSort = "views",
  direction: "asc" | "desc" = "desc", now = new Date(), scope: "saber" | "all" = "saber"): CohortRow[] {
  const start = windowStart(w, now);
  const titles = db.prepare(`SELECT t.*, p.title AS parent_title FROM yt_titles t LEFT JOIN yt_titles p ON p.title_id=t.parent_title_id
    WHERE t.enabled=1 AND (? = 'all' OR t.is_saber=1)`).all(scope) as any[];
  const agg = db.prepare(`
    SELECT title_id,
      COUNT(*) AS videos,
      SUM(is_short_form) AS short_form,
      COALESCE(SUM(view_count),0) AS views,
      COALESCE(SUM(comment_count),0) AS comments,
      COALESCE(SUM(like_count),0) AS likes,
      COALESCE(SUM(CASE WHEN like_count IS NOT NULL THEN view_count END),0) AS views_with_likes,
      SUM(CASE WHEN like_count IS NULL THEN 1 ELSE 0 END) AS likes_hidden,
      SUM(comments_disabled) AS comments_disabled,
      MIN(last_refreshed_at) AS stats_as_of
    FROM yt_videos
    WHERE (? IS NULL OR published_at >= ?)
    GROUP BY title_id`).all(start, start) as any[];
  const byId = new Map(agg.map((a) => [a.title_id, a]));
  const firstSeen = new Map((db.prepare("SELECT title_id, MIN(first_seen_at) AS s FROM yt_videos GROUP BY title_id").all() as any[]).map((r) => [r.title_id, r.s]));
  const topStmt = db.prepare(`SELECT video_id, title, channel_title, view_count, published_at, is_short_form FROM yt_videos
    WHERE title_id=? AND (? IS NULL OR published_at >= ?) ORDER BY view_count DESC, published_at DESC LIMIT 1`);

  const rows: CohortRow[] = titles.map((t) => {
    const a = byId.get(t.title_id);
    const top = a ? topStmt.get(t.title_id, start, start) as any : null;
    const floorIso = `${t.backfill_floor}T00:00:00.000Z`;
    return {
      titleId: t.title_id,
      title: t.title,
      steamAppId: t.steam_app_id,
      isSaber: !!t.is_saber,
      parentTitle: t.parent_title ?? null,
      views: a?.views ?? 0,
      videos: a?.videos ?? 0,
      shortForm: a?.short_form ?? 0,
      comments: a?.comments ?? 0,
      likes: a?.likes ?? 0,
      likesPct: a && a.views_with_likes > 0 ? (a.likes / a.views_with_likes) * 100 : null,
      likesHiddenVideos: a?.likes_hidden ?? 0,
      commentsDisabledVideos: a?.comments_disabled ?? 0,
      topVideo: top ? { videoId: top.video_id, title: top.title, channelTitle: top.channel_title, views: top.view_count ?? 0, publishedAt: top.published_at, isShortForm: !!top.is_short_form } : null,
      statsAsOf: a?.stats_as_of ?? null,
      trackingSince: firstSeen.get(t.title_id) ?? null,
      backfillComplete: !!t.backfill_oldest && t.backfill_oldest <= floorIso,
      backfillOldest: t.backfill_oldest,
      backfillFloor: t.backfill_floor,
    };
  });

  const dir = direction === "asc" ? 1 : -1;
  const val = (r: CohortRow): number | string | null => sort === "title" ? r.title.toLowerCase() : (r as any)[sort];
  rows.sort((x, y) => {
    const a = val(x), b = val(y);
    if (a == null && b == null) return x.title.localeCompare(y.title);
    if (a == null) return 1; // missing values sort last in both directions
    if (b == null) return -1;
    if (a < b) return -1 * dir;
    if (a > b) return 1 * dir;
    return y.views - x.views || x.title.localeCompare(y.title);
  });
  return rows;
}

export function listTitleVideos(db: YtDb, titleId: number, w: CohortWindow, limit = 100, now = new Date()) {
  const start = windowStart(w, now);
  return (db.prepare(`SELECT video_id, title, channel_title, published_at, duration_s, is_short_form,
      view_count, like_count, comment_count, comments_disabled, last_refreshed_at, match_reason
    FROM yt_videos WHERE title_id=? AND (? IS NULL OR published_at >= ?)
    ORDER BY view_count DESC, published_at DESC LIMIT ?`).all(titleId, start, start, limit) as any[]).map((v) => ({
    videoId: v.video_id,
    url: `https://www.youtube.com/watch?v=${v.video_id}`,
    title: v.title,
    channelTitle: v.channel_title,
    publishedAt: v.published_at,
    durationS: v.duration_s,
    isShortForm: !!v.is_short_form,
    views: v.view_count,
    likes: v.like_count,
    comments: v.comment_count,
    commentsDisabled: !!v.comments_disabled,
    statsAsOf: v.last_refreshed_at,
    matchReason: v.match_reason,
  }));
}
