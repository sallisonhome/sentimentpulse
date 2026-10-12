/**
 * TikTok comment feed for SentimentPulse consumption.
 *
 * Mirrors the YouTube comment feed: stable snapshot upper bound, independent
 * deletion watermark, and a per-`fetched_at` pagination cursor. SentimentPulse
 * uses `fetched_at` as the producer's `collected_at`; the original comment
 * publication time is `create_time`.
 */
import type { TtDb } from "./db";
import { RELEVANCE_VERSION } from "./relevance";

export function readCommentFeed(db: TtDb, input: {
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
  const rows = db.prepare(`SELECT c.*, v.desc AS video_desc, v.author_unique_id AS video_author,
      v.create_time AS video_create_time, t.title AS product_title, t.steam_app_id
    FROM tt_comments c JOIN tt_videos v ON v.aweme_id=c.aweme_id
      JOIN tt_titles t ON t.title_id=c.title_id
    WHERE t.enabled=1 AND v.relevance_version=? AND v.excluded_at IS NULL AND c.excluded_at IS NULL
      AND (c.fetched_at > ? OR (c.fetched_at = ? AND c.cid > ?))
      AND c.fetched_at <= ? AND (? IS NULL OR t.steam_app_id=?)
    ORDER BY c.fetched_at, c.cid LIMIT ?`)
    .all(RELEVANCE_VERSION, cFetched, cFetched, cId, until, app, app, limit) as any[];
  const tombstones = db.prepare(`SELECT tb.cid, tb.reason, tb.deleted_at, t.steam_app_id
    FROM tt_comment_tombstones tb LEFT JOIN tt_titles t ON t.title_id=tb.title_id
    WHERE tb.deleted_at >= ? AND tb.deleted_at <= ? AND (? IS NULL OR t.steam_app_id=?)
    ORDER BY tb.deleted_at, tb.cid`).all(deletedSince, until, app, app);
  const last = rows.at(-1);
  return {
    feedVersion: 1, relevanceVersion: RELEVANCE_VERSION, source: "tiktok_comment",
    since, snapshotAt: until,
    comments: rows.map(r => ({
      commentId: r.cid, awemeId: r.aweme_id,
      url: `https://www.tiktok.com/@${r.video_author ?? "unknown"}/video/${r.aweme_id}`,
      videoDesc: r.video_desc, videoAuthor: r.video_author, videoCreateTime: r.video_create_time,
      parentId: r.parent_id, authorUniqueId: r.author_unique_id, text: r.text, likeCount: r.like_count,
      createTime: r.create_time, isAuthorDigged: !!r.is_author_digged, replyCommentTotal: r.reply_comment_total,
      fetchedAt: r.fetched_at, titleId: r.title_id, productTitle: r.product_title, steamAppId: r.steam_app_id,
    })),
    tombstones,
    nextCursor: rows.length === limit && last ? `${last.fetched_at}|${last.cid}` : null,
  };
}
