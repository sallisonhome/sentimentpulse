/**
 * TikTok Pulse — daily pipeline.
 *
 * Order (each step is budgeted so a later step can never starve retention):
 *   1. retention   — refresh edits and exclusions; permanently retain tracked
 *                    video records, snapshots and comment text. Only the
 *                    rejected-search-candidate cache expires.
 *   2. discovery   — hashtag search per title, then keyword search per title.
 *                    Both use EnsembleData; each is 1 unit per ~20 posts.
 *   3. stats       — post info for every tracked video (2 units per post);
 *                    writes current stats + one daily snapshot row.
 *   4. comments    — new top-level comments (+ replies) per video, then
 *                    older-comment backfill as budget allows.
 *
 * Ground truth for "the run worked" is rows in tt_videos / tt_comments with
 * fresh timestamps, not the run status. The run row records both fetched
 * and saved counters separately.
 */
import type { TtDb } from "./db";
import {
  EnsembleDataClient, EnsembleDataUnitBudgetError, buildTikTokUrl,
  type TikTokPost, type TikTokComment,
} from "./api";
import { matchVideo, RELEVANCE_VERSION } from "./relevance";
import { matchConfigOf, type TitleRow } from "./titles";

const DAY = 86_400_000;
export const REJECTED_CACHE_MAX_DAYS = 30;
const DISCOVERY_HASHTAG_PAGES = 2;      // ~40 posts per hashtag per run
const DISCOVERY_KEYWORD_PAGES = 2;      // ~40 posts per keyword per run
const COMMENT_NEW_MAX_PAGES = 5;
/** How many videos per title the daily `comments` step polls. The plan was
 *  top-30 per title, not top-3 — this was requested but never implemented
 *  (runComments was hardcoded LIMIT 3). Top-30 × 5 pages × 1 unit = 150 units
 *  per title worst case, 900 units for all 6 titles. Under the 2,000-unit
 *  comments reserve. */
const COMMENT_TOP_VIDEOS_PER_TITLE = 30;
const COMMENT_BACKFILL_MAX_PAGES = 3;
const COMMENT_BACKFILL_AFTER_DAYS = 27;
/** Hard page ceiling for the 90-day backfill per video, so a video with a huge
 *  90-day slice doesn't drain the whole budget on one title. The early-exit
 *  cutoff usually stops it well before this. */
const BACKFILL_MAX_PAGES_PER_VIDEO = 60;
const RETENTION_UNIT_SHARE = 0.20;
const STATS_RESERVE_UNITS = 600;
/** Comments get priority — this is the user's actual goal. Stats and discovery
 *  only run if there are units left after comments. This is the reserve floor
 *  for comments alone. */
export const COMMENTS_RESERVE_UNITS = 2000;
/** Total daily budget on the Bronze plan (5,000 units/day). */
export const DAILY_UNIT_BUDGET = 5000;
export const DISCOVERY_SLAB_AGE_DAYS = 180;

export interface RunCounters {
  hashtagCalls: number;
  keywordCalls: number;
  postInfoCalls: number;
  commentCalls: number;
  units: number;
  videosDiscovered: number;
  videosRefreshed: number;
  videosRemoved: number;
  commentsSaved: number;
  commentsRefreshed: number;
  commentsDeleted: number;
  backfillVideos: number;
  backfillPages: number;
  backfillEarlyExits: number;
  notes: string[];
}

export interface PipelineOptions {
  retentionMode?: "unlimited";
  extendedStorageApproved: boolean; // legacy compatibility; retention no longer depends on this flag
  steps?: Array<"retention" | "discovery" | "stats" | "comments" | "backfill">;
  /** Only these title_ids run in the backfill step. Empty = all enabled. */
  backfillTitleIds?: number[];
  /** Days of comment history the backfill targets (default 90). */
  backfillWindowDays?: number;
  /** Hard unit cap for the backfill step alone (default 3500, under the 5000/day plan). */
  backfillUnitCap?: number;
  /** Only these title_ids run discovery/stats/comments. Empty = all enabled.
   *  This is the TikTok-specific scope, independent from tt_titles.enabled
   *  and independent from YouTube Pulse's scope. Set from
   *  tiktokScopeTitleIds() in routes-tiktok.ts. */
  scopeTitleIds?: number[];
  now?: () => Date;
}

const iso = (d: Date) => d.toISOString();
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Build a WHERE clause that respects the optional TikTok scope filter.
 *  Returns "" if scopeTitleIds is empty/undefined (track all enabled titles,
 *  the old behavior). */
function scopeFilter(opts: PipelineOptions, col: string): string {
  const ids = opts.scopeTitleIds ?? [];
  if (!ids.length) return "";
  return ` AND ${col} IN (${ids.join(",")})`;
}

/** Record actual API spend. The caller passes the per-request unit cost
 *  (EnsembleData documents: hashtag/keyword = 1 unit, postInfo = 2 units,
 *  postComments = 1 unit). EnsembleData sometimes reports `units_charged: 0`
 *  for cached results, but the attempt still counts against the daily quota,
 *  so we track the KNOWN cost, not the reported charge. This fixes the bug
 *  where `tt_quota_daily` was always empty and every budget check saw 0. */
function recordUnits(db: TtDb, counters: RunCounters, knownUnits: number, now: Date) {
  if (!knownUnits) return;
  counters.units += knownUnits;
  const d = isoDate(now);
  db.prepare(`INSERT INTO tt_quota_daily (pt_date, bucket, used) VALUES (?, 'units', ?)
    ON CONFLICT(pt_date, bucket) DO UPDATE SET used = used + ?`).run(d, knownUnits, knownUnits);
}

export function removeVideo(db: TtDb, awemeId: string, reason: string, now: Date): number {
  const ids = (db.prepare("SELECT cid FROM tt_comments WHERE aweme_id=? AND excluded_at IS NULL").all(awemeId) as any[]).map((r) => r.cid as string);
  const ins = db.prepare(`INSERT INTO tt_comment_tombstones (cid, title_id, aweme_id, reason, deleted_at)
    SELECT cid, title_id, aweme_id, ?, ? FROM tt_comments WHERE cid=? AND NOT EXISTS
      (SELECT 1 FROM tt_comment_tombstones tb WHERE tb.cid=tt_comments.cid)
    ON CONFLICT(cid) DO UPDATE SET reason=excluded.reason, deleted_at=excluded.deleted_at`);
  const del = db.prepare("UPDATE tt_comments SET excluded_at=? WHERE cid=? AND excluded_at IS NULL");
  let n = 0;
  db.transaction(() => {
    for (const id of ids) {
      ins.run(reason, iso(now), id);
      n += del.run(iso(now), id).changes;
    }
  })();
  db.prepare("UPDATE tt_videos SET excluded_at=?, exclusion_reason=? WHERE aweme_id=?").run(iso(now), reason, awemeId);
  return n;
}

export async function runRetention(db: TtDb, client: EnsembleDataClient | null, c: RunCounters, opts: PipelineOptions) {
  const now = (opts.now ?? (() => new Date()))();
  const hardBefore = iso(new Date(now.getTime() - REJECTED_CACHE_MAX_DAYS * DAY));
  db.prepare("DELETE FROM tt_rejected_videos WHERE seen_at < ?").run(hardBefore);

  if (client) {
    const usedToday = (db.prepare("SELECT COALESCE(used, 0) AS used FROM tt_quota_daily WHERE pt_date=? AND bucket='units'")
      .get(isoDate(now)) as any)?.used ?? 0;
    const budget = Math.floor((1500 - usedToday) * RETENTION_UNIT_SHARE);
    if (budget <= 0) { c.notes.push("retention: unit budget too low to refresh"); return; }
    const refreshBefore = iso(new Date(now.getTime() - COMMENT_BACKFILL_AFTER_DAYS * DAY));
    const due = (db.prepare(`SELECT cid, aweme_id FROM tt_comments WHERE title_id IN
        (SELECT title_id FROM tt_titles WHERE enabled=1${scopeFilter(opts, "title_id")})
      AND excluded_at IS NULL AND fetched_at < ? ORDER BY fetched_at LIMIT 2000`)
      .all(refreshBefore) as any[]).map((r) => ({ cid: r.cid as string, awemeId: r.aweme_id as string }));
    const ins = db.prepare(`INSERT INTO tt_comments (cid, aweme_id, title_id, parent_id, author_unique_id,
        text, like_count, create_time, is_author_digged, reply_comment_total, fetched_at)
      VALUES (@cid, @awemeId, @titleId, @parentId, @authorUniqueId, @text, @likeCount, @createTime,
        @isAuthorDigged, @replyCommentTotal, @fetchedAt)
      ON CONFLICT(cid) DO UPDATE SET text=excluded.text, like_count=excluded.like_count,
        is_author_digged=excluded.is_author_digged, reply_comment_total=excluded.reply_comment_total,
        fetched_at=excluded.fetched_at`);
    for (const d of due) {
      try {
        const res = await client.postComments(d.awemeId, 0);
        // postComments = 1 unit per request (per EnsembleData docs)
        recordUnits(db, c, 1, now);
        for (const cm of (res.data?.comments ?? []).slice(0, 60)) {
          const updated = (cm as TikTokComment).cid === d.cid;
          if (!updated) continue;
          ins.run({
            cid: (cm as TikTokComment).cid, awemeId: d.awemeId, titleId: titleIdOf(db, d.awemeId),
            parentId: (cm as TikTokComment).reply_id || null,
            authorUniqueId: (cm as TikTokComment).user?.unique_id ?? null,
            text: (cm as TikTokComment).text ?? "",
            likeCount: (cm as TikTokComment).digg_count ?? null,
            createTime: (cm as TikTokComment).create_time,
            isAuthorDigged: (cm as TikTokComment).is_author_digged ? 1 : 0,
            replyCommentTotal: (cm as TikTokComment).reply_comment_total ?? null,
            fetchedAt: iso(now),
          });
        }
        c.commentsRefreshed++;
      } catch (e) {
        if (e instanceof EnsembleDataUnitBudgetError) break;
        c.notes.push(`comment refresh: ${(e as Error).message}`); break;
      }
    }
  }
}

function titleIdOf(db: TtDb, awemeId: string): number | null {
  const row = db.prepare("SELECT title_id FROM tt_videos WHERE aweme_id=?").get(awemeId) as any;
  return row?.title_id ?? null;
}

async function admitPost(db: TtDb, client: EnsembleDataClient, c: RunCounters, t: TitleRow, p: TikTokPost,
  now: Date, discoveredVia: "hashtag" | "keyword", hashtag: string | null): Promise<void> {
  // Keyword-search results sometimes come back without an aweme_id
  // (TikTok's keyword API returns a different post shape for some
  // entries). Those can't be recorded — tt_rejected_videos.aweme_id
  // is NOT NULL — and are indistinguishable, so just skip them.
  if (!p.aweme_id) return;
  const cfg = matchConfigOf(t);
  const verdict = matchVideo(cfg, { desc: p.desc ?? "" });
  if (!verdict.admit) {
    db.prepare(`INSERT INTO tt_rejected_videos (aweme_id, title_id, reason, seen_at) VALUES (?,?,?,?)
      ON CONFLICT(aweme_id, title_id) DO UPDATE SET reason=excluded.reason, seen_at=excluded.seen_at`)
      .run(p.aweme_id, t.title_id, verdict.reason, iso(now));
    return;
  }
  const existing = db.prepare("SELECT excluded_at FROM tt_videos WHERE aweme_id=?").get(p.aweme_id) as any;
  const st = p.statistics ?? {};
  const upsert = db.prepare(`INSERT INTO tt_videos (aweme_id, title_id, author_unique_id, author_nickname, desc,
      create_time, view_count, like_count, comment_count, share_count, download_count, repost_count,
      forward_count, collect_count, match_reason, relevance_version, discovered_via, discovered_hashtag,
      first_seen_at, last_refreshed_at)
    VALUES (@awemeId, @titleId, @authorUniqueId, @authorNickname, @desc, @createTime,
      @viewCount, @likeCount, @commentCount, @shareCount, @downloadCount, @repostCount,
      @forwardCount, @collectCount, @matchReason, ${RELEVANCE_VERSION}, @discoveredVia, @discoveredHashtag,
      @firstSeenAt, @lastSeenAt)
    ON CONFLICT(aweme_id) DO UPDATE SET
      author_unique_id=excluded.author_unique_id, author_nickname=excluded.author_nickname,
      desc=excluded.desc, view_count=excluded.view_count, like_count=excluded.like_count,
      comment_count=excluded.comment_count, share_count=excluded.share_count,
      download_count=excluded.download_count, repost_count=excluded.repost_count,
      forward_count=excluded.forward_count, collect_count=excluded.collect_count,
      last_refreshed_at=excluded.last_refreshed_at`);
  const row = {
    awemeId: p.aweme_id, titleId: t.title_id,
    authorUniqueId: p.author?.unique_id ?? null,
    authorNickname: p.author?.nickname ?? null,
    desc: p.desc ?? "",
    createTime: p.create_time,
    viewCount: st.play_count ?? null, likeCount: st.digg_count ?? null,
    commentCount: st.comment_count ?? null, shareCount: st.share_count ?? null,
    downloadCount: st.download_count ?? null, repostCount: st.repost_count ?? null,
    forwardCount: st.forward_count ?? null, collectCount: st.collect_count ?? null,
    matchReason: verdict.reason, discoveredVia, discoveredHashtag: hashtag,
    firstSeenAt: iso(now), lastSeenAt: iso(now),
  };
  upsert.run(row);
  if (!existing) c.videosDiscovered++;
}

export async function runDiscovery(db: TtDb, client: EnsembleDataClient, c: RunCounters, opts: PipelineOptions) {
  const now = (opts.now ?? (() => new Date()))();
  // Budget check: comments already ran (they get priority), so discovery only
  // runs if there's real budget left. ~48 titles × ~8 hashtags/keywords × 2 pages
  // × 1 unit = ~400-700 units per full discovery pass.
  const today = isoDate(now);
  const usedToday = (db.prepare("SELECT COALESCE(used,0) AS used FROM tt_quota_daily WHERE pt_date=? AND bucket='units'")
    .get(today) as any)?.used ?? 0;
  if (usedToday >= DAILY_UNIT_BUDGET - COMMENTS_RESERVE_UNITS) {
    c.notes.push(`discovery: unit budget too low (used ${usedToday}/${DAILY_UNIT_BUDGET})`); return;
  }
  const titles = (db.prepare(`SELECT * FROM tt_titles WHERE enabled=1${scopeFilter(opts, "title_id")}`).all() as any[]) as unknown as TitleRow[];
  for (const t of titles) {
    const hashtags = JSON.parse((t as any).hashtags ?? "[]") as string[];
    for (const h of hashtags) {
      for (let page = 0; page < DISCOVERY_HASHTAG_PAGES; page++) {
        try {
          const res = await client.hashtagPosts(h, page * 20);
          // hashtagPosts = 1 unit per request (per EnsembleData docs)
          recordUnits(db, c, 1, now);
          c.hashtagCalls++;
          for (const p of (res.data?.data ?? [])) {
            await admitPost(db, client, c, t, p as TikTokPost, now, "hashtag", h);
          }
          if (!res.data?.nextCursor) break;
        } catch (e) {
          if (e instanceof EnsembleDataUnitBudgetError) {
            c.notes.push(`discovery: hashtag ${h} hit unit budget`); break;
          }
          c.notes.push(`hashtag ${h}: ${(e as Error).message}`); break;
        }
      }
    }
    const keywords = JSON.parse((t as any).keywords ?? "[]") as string[];
    for (const k of keywords) {
      for (let page = 0; page < DISCOVERY_KEYWORD_PAGES; page++) {
        try {
          const res = await client.keywordSearch(k, { cursor: page * 20 });
          // keywordSearch = 1 unit per request (per EnsembleData docs)
          recordUnits(db, c, 1, now);
          c.keywordCalls++;
          for (const p of (res.data?.data ?? [])) {
            await admitPost(db, client, c, t, p as TikTokPost, now, "keyword", null);
          }
          if (!res.data?.nextCursor) break;
        } catch (e) {
          if (e instanceof EnsembleDataUnitBudgetError) {
            c.notes.push(`discovery: keyword "${k}" hit unit budget`); break;
          }
          c.notes.push(`keyword ${k}: ${(e as Error).message}`); break;
        }
      }
    }
    db.prepare("UPDATE tt_titles SET last_incremental_at=? WHERE title_id=?").run(iso(now), t.title_id);
  }
}

export async function runStats(db: TtDb, client: EnsembleDataClient, c: RunCounters, opts: PipelineOptions) {
  const now = (opts.now ?? (() => new Date()))();
  const today = isoDate(now);
  const usedToday = (db.prepare("SELECT COALESCE(used,0) AS used FROM tt_quota_daily WHERE pt_date=? AND bucket='units'")
    .get(today) as any)?.used ?? 0;
  // Budget check: comments already ran (they get priority), so stats only
  // runs if there's real budget left. We now track the KNOWN per-call cost
  // (postInfo = 2 units) so this actually fires instead of always seeing 0.
  if (usedToday >= DAILY_UNIT_BUDGET - STATS_RESERVE_UNITS) {
    c.notes.push(`stats: unit budget too low (used ${usedToday}/${DAILY_UNIT_BUDGET})`); return;
  }
  const videos = db.prepare(`SELECT v.* FROM tt_videos v JOIN tt_titles t ON t.title_id=v.title_id
    WHERE v.excluded_at IS NULL AND t.enabled=1${scopeFilter(opts, "t.title_id")}`).all() as any[];
  const statsUpsert = db.prepare(`INSERT INTO tt_video_stats_daily (aweme_id, date, view_count, like_count,
      comment_count, share_count, repost_count, download_count)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(aweme_id, date) DO UPDATE SET view_count=excluded.view_count, like_count=excluded.like_count,
      comment_count=excluded.comment_count, share_count=excluded.share_count,
      repost_count=excluded.repost_count, download_count=excluded.download_count`);
  const upd = db.prepare(`UPDATE tt_videos SET view_count=?, like_count=?, comment_count=?, share_count=?,
    download_count=?, repost_count=?, forward_count=?, collect_count=?, last_refreshed_at=? WHERE aweme_id=?`);
  for (const v of ordered) {
    try {
      const url = buildTikTokUrl(v.author_unique_id, v.aweme_id);
      const res = await client.postInfo(url);
      // postInfo = 2 units per request (per EnsembleData docs) — this was the
      // budget killer: 870 videos × 2 units = 1,740 units in one stats pass
      recordUnits(db, c, 2, now);
      c.postInfoCalls++;
      // EnsembleData /tt/post/info returns { data: [post, ...] } — an array,
      // not { data: { post } }. Same shape as hashtag/keyword discovery
      // responses. Prior code read res.data?.post, which was always
      // undefined, so runStats silently no-oped on every video.
      const p = Array.isArray(res.data)
        ? (res.data as any[]).find((x) => x?.aweme_id === v.aweme_id) ?? (res.data as any[])[0]
        : (res.data as any)?.post;
      if (!p) continue;
      const st = p.statistics ?? {};
      upd.run(st.play_count ?? v.view_count, st.digg_count ?? v.like_count, st.comment_count ?? v.comment_count,
        st.share_count ?? v.share_count, st.download_count ?? v.download_count,
        st.repost_count ?? v.repost_count, st.forward_count ?? v.forward_count,
        st.collect_count ?? v.collect_count, iso(now), v.aweme_id);
      statsUpsert.run(v.aweme_id, today, st.play_count ?? null, st.digg_count ?? null, st.comment_count ?? null,
        st.share_count ?? null, st.repost_count ?? null, st.download_count ?? null);
      c.videosRefreshed++;
    } catch (e) {
      if (e instanceof EnsembleDataUnitBudgetError) {
        c.notes.push("stats: unit budget exhausted"); break;
      }
      c.notes.push(`stats ${v.aweme_id}: ${(e as Error).message}`);
    }
  }
}

export async function runComments(db: TtDb, client: EnsembleDataClient, c: RunCounters, opts: PipelineOptions) {
  const now = (opts.now ?? (() => new Date()))();
  const today = isoDate(now);
  const usedToday = (db.prepare("SELECT COALESCE(used,0) AS used FROM tt_quota_daily WHERE pt_date=? AND bucket='units'")
    .get(today) as any)?.used ?? 0;
  const remaining = Math.max(0, DAILY_UNIT_BUDGET - usedToday);
  // Soft cap on comments per run so one pass doesn't eat the whole day's budget
  // and stats/discovery never get a chance. Comments = 1 unit per request,
  // 5 pages max per video, top 3 videos per title.
  const commentsBudget = Math.min(remaining, COMMENTS_RESERVE_UNITS);
  const titles = db.prepare(`SELECT * FROM tt_titles WHERE enabled=1${scopeFilter(opts, "title_id")}`).all() as any[];
  const ins = db.prepare(`INSERT INTO tt_comments (cid, aweme_id, title_id, parent_id, author_unique_id,
      text, like_count, create_time, is_author_digged, reply_comment_total, fetched_at)
    VALUES (@cid, @awemeId, @titleId, @parentId, @authorUniqueId, @text, @likeCount, @createTime,
      @isAuthorDigged, @replyCommentTotal, @fetchedAt)
    ON CONFLICT(cid) DO UPDATE SET text=excluded.text, like_count=excluded.like_count,
      is_author_digged=excluded.is_author_digged, reply_comment_total=excluded.reply_comment_total,
      fetched_at=excluded.fetched_at`);
  for (const t of titles) {
    const videos = db.prepare(`SELECT aweme_id, comment_count FROM tt_videos WHERE title_id=? AND excluded_at IS NULL
      ORDER BY COALESCE(view_count,0) DESC LIMIT ${COMMENT_TOP_VIDEOS_PER_TITLE}`).all(t.title_id) as any[];
    for (const v of videos) {
      for (let page = 0; page < COMMENT_NEW_MAX_PAGES; page++) {
        try {
          // Budget guard: stop when we've used our comments allowance
          if (c.units >= usedToday + commentsBudget) {
            c.notes.push(`comments: unit budget for this pass reached (${c.units - usedToday}/${commentsBudget})`);
            break;
          }
          const res = await client.postComments(v.aweme_id, page * 30);
          // postComments = 1 unit per request (per EnsembleData docs)
          recordUnits(db, c, 1, now);
          c.commentCalls++;
          const cs = (res.data?.comments ?? []) as TikTokComment[];
          for (const cm of cs) {
            ins.run({
              cid: cm.cid, awemeId: v.aweme_id, titleId: t.title_id,
              parentId: cm.reply_id || null,
              authorUniqueId: cm.user?.unique_id ?? null,
              text: cm.text ?? "",
              likeCount: cm.digg_count ?? null, createTime: cm.create_time,
              isAuthorDigged: cm.is_author_digged ? 1 : 0,
              replyCommentTotal: cm.reply_comment_total ?? null,
              fetchedAt: iso(now),
            });
            c.commentsSaved++;
          }
          if (!res.data?.nextCursor) break;
        } catch (e) {
          if (e instanceof EnsembleDataUnitBudgetError) {
            c.notes.push("comments: unit budget exhausted"); break;
          }
          c.notes.push(`comments ${v.aweme_id}: ${(e as Error).message}`); break;
        }
      }
    }
  }
}

export async function runBackfill(db: TtDb, client: EnsembleDataClient, c: RunCounters, opts: PipelineOptions) {
  /** Walks each title's tracked pool and paginates each video's comments
   *  until the oldest create_time on a page falls outside the window. The
   *  early-exit is the cost saver: a video whose 90-day slice fits in 1-3
   *  pages costs 1-3 units instead of draining full lifetime history. */
  const now = (opts.now ?? (() => new Date()))();
  const windowDays = opts.backfillWindowDays ?? 90;
  const unitCap = opts.backfillUnitCap ?? 3500;
  const cutoffSec = Math.floor((now.getTime() - windowDays * DAY) / 1000);
  const scoped = (opts.backfillTitleIds ?? []).length
    ? db.prepare("SELECT * FROM tt_titles WHERE title_id IN (" + (opts.backfillTitleIds ?? []).map(() => "?").join(",") + ") AND enabled=1")
        .all(...(opts.backfillTitleIds ?? [])) as any[]
    : db.prepare(`SELECT * FROM tt_titles WHERE enabled=1${scopeFilter(opts, "title_id")}`).all() as any[];
  if (!scoped.length) { c.notes.push("backfill: no eligible titles"); return; }
  const usedToday = (db.prepare("SELECT COALESCE(used, 0) AS used FROM tt_quota_daily WHERE pt_date=? AND bucket='units'")
    .get(isoDate(now)) as any)?.used ?? 0;
  if (usedToday >= unitCap) { c.notes.push("backfill: unit budget exhausted before start"); return; }
  const ins = db.prepare(`INSERT INTO tt_comments (cid, aweme_id, title_id, parent_id, author_unique_id,
      text, like_count, create_time, is_author_digged, reply_comment_total, fetched_at)
    VALUES (@cid, @awemeId, @titleId, @parentId, @authorUniqueId, @text, @likeCount, @createTime,
      @isAuthorDigged, @replyCommentTotal, @fetchedAt)
    ON CONFLICT(cid) DO UPDATE SET text=excluded.text, like_count=excluded.like_count,
      is_author_digged=excluded.is_author_digged, reply_comment_total=excluded.reply_comment_total,
      fetched_at=excluded.fetched_at`);
  for (const t of scoped) {
    if (c.units + usedToday >= unitCap) { c.notes.push("backfill: unit budget exhausted mid-title"); break; }
    const videos = db.prepare(`SELECT aweme_id FROM tt_videos WHERE title_id=? AND excluded_at IS NULL
      ORDER BY COALESCE(view_count,0) DESC`).all(t.title_id) as any[];
    let titleStopped = false;
    for (const v of videos) {
      if (c.units + usedToday >= unitCap) { c.notes.push("backfill: unit budget exhausted mid-video"); titleStopped = true; break; }
      c.backfillVideos++;
      let cursor = 0;
      // paginate until the oldest comment on a page is older than the cutoff
      for (let page = 0; page < BACKFILL_MAX_PAGES_PER_VIDEO; page++) {
        try {
          const res = await client.postComments(v.aweme_id, cursor);
          // postComments = 1 unit per request (per EnsembleData docs)
          recordUnits(db, c, 1, now);
          c.backfillPages++; c.commentCalls++;
          const cs = (res.data?.comments ?? []) as TikTokComment[];
          if (!cs.length) break;
          for (const cm of cs) {
            if (cm.create_time < cutoffSec) continue; // outside window, skip but keep scanning
            ins.run({
              cid: cm.cid, awemeId: v.aweme_id, titleId: t.title_id,
              parentId: cm.reply_id || null,
              authorUniqueId: cm.user?.unique_id ?? null,
              text: cm.text ?? "",
              likeCount: cm.digg_count ?? null, createTime: cm.create_time,
              isAuthorDigged: cm.is_author_digged ? 1 : 0,
              replyCommentTotal: cm.reply_comment_total ?? null,
              fetchedAt: iso(now),
            });
            c.commentsSaved++;
          }
          // early exit: oldest comment on this page is already outside the window
          const oldestOnPage = Math.min(...cs.map((cm: TikTokComment) => cm.create_time));
          if (oldestOnPage < cutoffSec) { c.backfillEarlyExits++; break; }
          cursor = res.data?.nextCursor ?? 0;
          if (!cursor) break;
        } catch (e) {
          if (e instanceof EnsembleDataUnitBudgetError) {
            c.notes.push("backfill: unit budget exhausted"); return;
          }
          c.notes.push(`backfill ${v.aweme_id}: ${(e as Error).message}`); break;
        }
      }
    }
    if (titleStopped) break;  // don't proceed to the next title — the whole run is capped
  }
}

export async function runPipeline(db: TtDb, client: EnsembleDataClient | null, opts: PipelineOptions,
  trigger: string, runRow?: { id: number }): Promise<RunCounters> {
  const now = (opts.now ?? (() => new Date()))();
  const c: RunCounters = {
    hashtagCalls: 0, keywordCalls: 0, postInfoCalls: 0, commentCalls: 0, units: 0,
    videosDiscovered: 0, videosRefreshed: 0, videosRemoved: 0,
    commentsSaved: 0, commentsRefreshed: 0, commentsDeleted: 0,
    backfillVideos: 0, backfillPages: 0, backfillEarlyExits: 0, notes: [],
  };
  const steps = opts.steps ?? ["retention", "comments", "stats", "discovery"];
  const withClient = client ?? null;
  // COMMENTS RUN FIRST — the user's actual goal is TikTok comments flowing into
  // SentimentPulse. Discovery and stats eat the budget fast (870 postInfo calls
  // at 2 units = 1,740 units; ~350 discovery calls at 1 unit = ~350 units) and
  // by the time comments would run the daily budget is dead. This was the
  // root cause of runs 5/6/7 burning 5,000 units with 0 comments saved.
  if (steps.includes("retention")) await runRetention(db, withClient, c, opts);
  if (steps.includes("comments") && withClient) await runComments(db, withClient, c, opts);
  if (steps.includes("backfill") && withClient) await runBackfill(db, withClient, c, opts);
  if (steps.includes("stats") && withClient) await runStats(db, withClient, c, opts);
  if (steps.includes("discovery") && withClient) await runDiscovery(db, withClient, c, opts);
  if (runRow?.id) {
    // finished_at should be the ACTUAL end time, not the run's start time
    // (the pre-existing code passed iso(now) which is the run's start).
    const finishedAt = new Date().toISOString();
    db.prepare(`UPDATE tt_ingest_runs SET finished_at=?, status=?,
      hashtag_calls=?, keyword_calls=?, post_info_calls=?, comment_calls=?,
      units_used=?, videos_discovered=?, videos_refreshed=?, videos_removed=?,
      comments_saved=?, comments_refreshed=?, comments_deleted=?, message=?
      WHERE id=?`).run(finishedAt, c.notes.length ? "partial" : "success",
      c.hashtagCalls, c.keywordCalls, c.postInfoCalls, c.commentCalls,
      c.units, c.videosDiscovered, c.videosRefreshed, c.videosRemoved,
      c.commentsSaved, c.commentsRefreshed, c.commentsDeleted,
      c.notes.length ? c.notes.join("; ") : null, runRow.id);
  }
  return c;
}

/** Backfill-aware wrapper. Records backfill counters in the run's message
 *  so operators can see how many videos hit the early exit.
 *
 *  IMPORTANT: this used to hardcode steps:["backfill"], which silently
 *  overrode any steps the caller passed (including "discovery" and "stats").
 *  That was the root cause of the "0 videos, 0 comments" backfill — the
 *  backfill only paginates comments for videos already in tt_videos, and
 *  without discovery the pool was empty. Now it passes the caller's steps
 *  through (falling back to ["backfill"] if none given). */
export async function runBackfillStep(db: TtDb, client: EnsembleDataClient, opts: PipelineOptions,
  trigger: string, runRow?: { id: number }): Promise<RunCounters> {
  const steps: NonNullable<PipelineOptions["steps"]> = opts.steps && opts.steps.length ? opts.steps : ["backfill"];
  const c = await runPipeline(db, client, { ...opts, steps }, trigger, runRow);
  if (runRow?.id) {
    const backfillNote = `backfill: ${c.backfillVideos} videos, ${c.backfillPages} pages, ` +
      `${c.backfillEarlyExits} early-exits, ${c.commentsSaved} comments saved`;
    db.prepare(`UPDATE tt_ingest_runs SET message=COALESCE(message, '') || ? WHERE id=?`)
      .run(backfillNote, runRow.id);
  }
  return c;
}
