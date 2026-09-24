import type { YtDb } from "./db";
import { RELEVANCE_VERSION } from "./relevance";

/** Stable snapshot upper bound and independent deletion watermark. */
export function readCommentFeed(db: YtDb, input: {
  since?: string; until?: string; cursor?: string; deletedSince?: string;
  limit?: number; steamAppId?: string;
}, now = new Date()) {
  const stamp = (value: string | undefined, fallback: string) => {
    const d = new Date(value ?? fallback);
    if (!Number.isFinite(d.getTime())) throw new Error("invalid feed timestamp");
    return d.toISOString();
  };
  const epoch = "1970-01-01T00:00:00.000Z";
  const since = stamp(input.since, epoch);
  const until = stamp(input.until, new Date(now.getTime() - 1000).toISOString());
  const deletedSince = stamp(input.deletedSince, since);
  if (until > now.toISOString() || since > until) throw new Error("invalid feed window");
  const limit = Math.min(2000, Math.max(1, Math.floor(input.limit || 500)));
  let cFetched = since, cId = "";
  if (input.cursor) {
    const at = input.cursor.indexOf("|");
    if (at < 0) throw new Error("invalid feed cursor");
    cFetched = stamp(input.cursor.slice(0, at), since);
    cId = input.cursor.slice(at + 1);
    if (!cId || cFetched < since || cFetched > until) throw new Error("invalid feed cursor");
  }
  const app = input.steamAppId ?? null;
  const rows = db.prepare(`SELECT c.*, v.title AS video_title, v.channel_title,
      v.published_at AS video_published_at, t.title AS product_title, t.steam_app_id
    FROM yt_comments c JOIN yt_videos v ON v.video_id=c.video_id
      JOIN yt_titles t ON t.title_id=c.title_id
    WHERE t.enabled=1 AND v.relevance_version=? AND v.excluded_at IS NULL AND c.excluded_at IS NULL
      AND (c.fetched_at > ? OR (c.fetched_at = ? AND c.comment_id > ?))
      AND c.fetched_at <= ? AND (? IS NULL OR t.steam_app_id=?)
    ORDER BY c.fetched_at,c.comment_id LIMIT ?`)
    .all(RELEVANCE_VERSION, cFetched, cFetched, cId, until, app, app, limit) as any[];
  // Deletions are independent of comment pagination, including deletion-only
  // pages and resumes after a failed request.
  const tombstones = db.prepare(`SELECT tb.comment_id,tb.reason,tb.deleted_at,t.steam_app_id
    FROM yt_comment_tombstones tb LEFT JOIN yt_titles t ON t.title_id=tb.title_id
    WHERE tb.deleted_at >= ? AND tb.deleted_at <= ? AND (? IS NULL OR t.steam_app_id=?)
    ORDER BY tb.deleted_at,tb.comment_id`).all(deletedSince, until, app, app);
  const last = rows.at(-1);
  return {
    feedVersion: 2, relevanceVersion: RELEVANCE_VERSION, source: "youtube_comment",
    since, snapshotAt: until,
    comments: rows.map(r => ({
      commentId: r.comment_id, videoId: r.video_id,
      url: `https://www.youtube.com/watch?v=${r.video_id}&lc=${r.comment_id}`,
      videoTitle: r.video_title, channelTitle: r.channel_title, videoPublishedAt: r.video_published_at,
      parentId: r.parent_id, authorChannelId: r.author_channel_id, text: r.text, likeCount: r.like_count,
      publishedAt: r.published_at, updatedAt: r.updated_at, fetchedAt: r.fetched_at,
      titleId: r.title_id, productTitle: r.product_title, steamAppId: r.steam_app_id,
    })),
    tombstones,
    nextCursor: rows.length === limit && last ? `${last.fetched_at}|${last.comment_id}` : null,
  };
}
