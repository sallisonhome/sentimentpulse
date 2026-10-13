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
const COMMENT_BACKFILL_MAX_PAGES = 3;
const COMMENT_BACKFILL_AFTER_DAYS = 27;
/** Hard page ceiling for the 90-day backfill per video, so a video with a huge
 *  90-day slice doesn't drain the whole budget on one title. The early-exit
 *  cutoff usually stops it well before this. */
const BACKFILL_MAX_PAGES_PER_VIDEO = 60;
const RETENTION_UNIT_SHARE = 0.20;
const STATS_RESERVE_UNITS = 600;
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
  now?: () => Date;
}

const iso = (d: Date) => d.toISOString();
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function recordUnits(db: TtDb, counters: RunCounters, units: number, now: Date) {
  if (!units) return;
  counters.units += units;
  const d = isoDate(now);
  db.prepare(`INSERT INTO tt_quota_daily (pt_date, bucket, used) VALUES (?, 'units', ?)
    ON CONFLICT(pt_date, bucket) DO UPDATE SET used = used + ?`).run(d, units, units);
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
        (SELECT title_id FROM tt_titles WHERE enabled=1)
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
        recordUnits(db, c, res.units_charged ?? 0, now);
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
  const titles = (db.prepare("SELECT * FROM tt_titles WHERE enabled=1").all() as any[]) as unknown as TitleRow[];
  for (const t of titles) {
    const hashtags = JSON.parse((t as any).hashtags ?? "[]") as string[];
    for (const h of hashtags) {
      for (let page = 0; page < DISCOVERY_HASHTAG_PAGES; page++) {
        try {
          const res = await client.hashtagPosts(h, page * 20);
          recordUnits(db, c, res.units_charged ?? 0, now);
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
          recordUnits(db, c, res.units_charged ?? 0, now);
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
  if (usedToday > 1500 - STATS_RESERVE_UNITS) { c.notes.push("stats: unit budget too low"); return; }
  const videos = db.prepare(`SELECT v.* FROM tt_videos v JOIN tt_titles t ON t.title_id=v.title_id
    WHERE v.excluded_at IS NULL AND t.enabled=1`).all() as any[];
  const statsUpsert = db.prepare(`INSERT INTO tt_video_stats_daily (aweme_id, date, view_count, like_count,
      comment_count, share_count, repost_count, download_count)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(aweme_id, date) DO UPDATE SET view_count=excluded.view_count, like_count=excluded.like_count,
      comment_count=excluded.comment_count, share_count=excluded.share_count,
      repost_count=excluded.repost_count, download_count=excluded.download_count`);
  const upd = db.prepare(`UPDATE tt_videos SET view_count=?, like_count=?, comment_count=?, share_count=?,
    download_count=?, repost_count=?, forward_count=?, collect_count=?, last_refreshed_at=? WHERE aweme_id=?`);
  for (const v of videos) {
    try {
      const url = buildTikTokUrl(v.author_unique_id, v.aweme_id);
      const res = await client.postInfo(url);
      recordUnits(db, c, res.units_charged ?? 0, now);
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
  const titles = db.prepare("SELECT * FROM tt_titles WHERE enabled=1").all() as any[];
  const ins = db.prepare(`INSERT INTO tt_comments (cid, aweme_id, title_id, parent_id, author_unique_id,
      text, like_count, create_time, is_author_digged, reply_comment_total, fetched_at)
    VALUES (@cid, @awemeId, @titleId, @parentId, @authorUniqueId, @text, @likeCount, @createTime,
      @isAuthorDigged, @replyCommentTotal, @fetchedAt)
    ON CONFLICT(cid) DO UPDATE SET text=excluded.text, like_count=excluded.like_count,
      is_author_digged=excluded.is_author_digged, reply_comment_total=excluded.reply_comment_total,
      fetched_at=excluded.fetched_at`);
  for (const t of titles) {
    const videos = db.prepare(`SELECT aweme_id, comment_count FROM tt_videos WHERE title_id=? AND excluded_at IS NULL
      ORDER BY COALESCE(view_count,0) DESC LIMIT 3`).all(t.title_id) as any[];
    for (const v of videos) {
      for (let page = 0; page < COMMENT_NEW_MAX_PAGES; page++) {
        try {
          const res = await client.postComments(v.aweme_id, page * 30);
          recordUnits(db, c, res.units_charged ?? 0, now);
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
    : db.prepare("SELECT * FROM tt_titles WHERE enabled=1").all() as any[];
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
          recordUnits(db, c, res.units_charged ?? 0, now);
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
  const steps = opts.steps ?? ["retention", "discovery", "stats", "comments"];
  const withClient = client ?? null;
  if (steps.includes("retention")) await runRetention(db, withClient, c, opts);
  if (steps.includes("discovery") && withClient) await runDiscovery(db, withClient, c, opts);
  if (steps.includes("stats") && withClient) await runStats(db, withClient, c, opts);
  if (steps.includes("comments") && withClient) await runComments(db, withClient, c, opts);
  if (steps.includes("backfill") && withClient) await runBackfill(db, withClient, c, opts);
  if (runRow?.id) {
    db.prepare(`UPDATE tt_ingest_runs SET finished_at=?, status=?,
      hashtag_calls=?, keyword_calls=?, post_info_calls=?, comment_calls=?,
      units_used=?, videos_discovered=?, videos_refreshed=?, videos_removed=?,
      comments_saved=?, comments_refreshed=?, comments_deleted=?, message=?
      WHERE id=?`).run(iso(now), c.notes.length ? "partial" : "success",
      c.hashtagCalls, c.keywordCalls, c.postInfoCalls, c.commentCalls,
      c.units, c.videosDiscovered, c.videosRefreshed, c.videosRemoved,
      c.commentsSaved, c.commentsRefreshed, c.commentsDeleted,
      c.notes.length ? c.notes.join("; ") : null, runRow.id);
  }
  return c;
}

/** Backfill-aware wrapper. Records backfill counters in the run's message
 *  so operators can see how many videos hit the early exit. */
export async function runBackfillStep(db: TtDb, client: EnsembleDataClient, opts: PipelineOptions,
  trigger: string, runRow?: { id: number }): Promise<RunCounters> {
  const c = await runPipeline(db, client, { ...opts, steps: ["backfill"] }, trigger, runRow);
  if (runRow?.id) {
    const backfillNote = `backfill: ${c.backfillVideos} videos, ${c.backfillPages} pages, ` +
      `${c.backfillEarlyExits} early-exits, ${c.commentsSaved} comments saved`;
    db.prepare(`UPDATE tt_ingest_runs SET message=COALESCE(message, '') || ? WHERE id=?`)
      .run(backfillNote, runRow.id);
  }
  return c;
}
