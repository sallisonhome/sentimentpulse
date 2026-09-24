/**
 * YouTube Pulse — daily pipeline.
 *
 * Order (each step is budgeted so a later step can never starve retention):
 *   1. retention   — refresh edits and exclusions; permanently retain tracked
 *                    video records, snapshots and comment text. Only the
 *                    rejected-search-candidate cache expires.
 *   2. discovery   — incremental search per title (newest videos), then
 *                    backwards backfill slices toward each title's floor.
 *   3. stats       — videos.list for every tracked video (50 per unit);
 *                    writes current stats + one daily snapshot row.
 *   4. comments    — new top-level threads (+ replies) per video, then
 *                    older-comment backfill as budget allows.
 *
 * Ground truth for "the run worked" is rows in yt_videos / yt_comments with
 * fresh timestamps, not the run status (CLAUDE.md §19). The run row records
 * both fetched and saved counters separately.
 */
import type { YtDb } from "./db";
import { YouTubeClient, QuotaExhaustedError, YouTubeApiError, quotaRemaining } from "./api";
import { matchVideo, parseIsoDuration, isShortForm, RELEVANCE_VERSION } from "./relevance";
import { matchConfigOf, type TitleRow } from "./titles";

const DAY = 86_400_000;
export const COMMENT_REFRESH_AFTER_DAYS = 27;
export const REJECTED_CACHE_MAX_DAYS = 30;
const SEARCH_RESERVE = 9;           // search calls left for one-off lookups (3 × 3 pages) and dry-runs
const RETENTION_UNIT_SHARE = 0.35;  // max share of units for comment-text refresh
const STATS_RESERVE_UNITS = 1500;   // held back for stats before comments may spend
const INCREMENTAL_MAX_PAGES = 3;
const BACKFILL_MAX_PAGES = 4;
const COMMENT_NEW_MAX_PAGES = 5;
const COMMENT_BACKFILL_MAX_PAGES = 3;
const REPLY_MAX_PAGES = 2;

export interface RunCounters {
  searchCalls: number; units: number;
  // Legacy field names: Removed/Deleted count EXCLUSIONS, not physical erasure.
  videosDiscovered: number; videosRefreshed: number; videosRemoved: number;
  commentsSaved: number; commentsRefreshed: number; commentsDeleted: number;
  notes: string[];
}

export type RetentionMode = "unlimited";

export interface PipelineOptions {
  /** Permanent retention: no age-based deletion of tracked data. */
  retentionMode?: RetentionMode;
  /** Legacy caller compatibility; retention no longer depends on this flag. */
  extendedStorageApproved: boolean;
  steps?: Array<"retention" | "discovery" | "stats" | "comments">;
  now?: () => Date;
}

const iso = (d: Date) => d.toISOString();

function tombstone(db: YtDb, commentIds: string[], reason: string, now: Date) {
  if (!commentIds.length) return 0;
  const ins = db.prepare(`INSERT INTO yt_comment_tombstones (comment_id, title_id, reason, deleted_at)
    SELECT comment_id, title_id, ?, ? FROM yt_comments WHERE comment_id=?
    ON CONFLICT(comment_id) DO UPDATE SET reason=excluded.reason, deleted_at=excluded.deleted_at`);
  const del = db.prepare("UPDATE yt_comments SET excluded_at=? WHERE comment_id=? AND excluded_at IS NULL");
  let n = 0;
  db.transaction(() => { for (const id of commentIds) { ins.run(reason, iso(now), id); n += del.run(iso(now), id).changes; } })();
  return n;
}

export function removeVideo(db: YtDb, videoId: string, reason: string, now: Date): number {
  const ids = (db.prepare("SELECT comment_id FROM yt_comments WHERE video_id=? AND excluded_at IS NULL").all(videoId) as any[]).map((r) => r.comment_id);
  const n = tombstone(db, ids, reason, now);
  // Historical rows and snapshots are permanent. Exclusion is not erasure.
  db.prepare("UPDATE yt_videos SET excluded_at=?, exclusion_reason=? WHERE video_id=?").run(iso(now), reason, videoId);
  return n;
}

// ─── 1. Retention ────────────────────────────────────────────────────────────

export async function runRetention(db: YtDb, yt: YouTubeClient | null, c: RunCounters, opts: PipelineOptions) {
  const now = (opts.now ?? (() => new Date()))();
  const refreshBefore = iso(new Date(now.getTime() - COMMENT_REFRESH_AFTER_DAYS * DAY));
  const hardBefore = iso(new Date(now.getTime() - REJECTED_CACHE_MAX_DAYS * DAY));

  // Caches that are not "data" in the user-facing sense are trimmed in every mode.
  const trimCaches = () => {
    db.prepare("DELETE FROM yt_rejected_videos WHERE seen_at < ?").run(hardBefore); // re-judge rejects monthly
    // Keep deletion events until consumers have acknowledged them. Age-only
    // deletion could resurrect stale comments after a long consumer outage.
  };
  // Refresh older comment text on a rolling basis, without an expiry deadline.
  if (yt) {
    const budget = Math.floor(quotaRemaining(db, "units") * RETENTION_UNIT_SHARE);
    const due = (db.prepare("SELECT comment_id FROM yt_comments WHERE excluded_at IS NULL AND fetched_at < ? ORDER BY fetched_at LIMIT ?")
      .all(refreshBefore, budget * 50) as any[]).map((r) => r.comment_id as string);
    const upd = db.prepare("UPDATE yt_comments SET text=?, like_count=?, updated_at=?, author_channel_id=?, fetched_at=? WHERE comment_id=?");
    for (let i = 0; i < due.length; i += 50) {
      const batch = due.slice(i, i + 50);
      let res: any;
      try { res = await yt.commentsById(batch); } catch (e) {
        if (e instanceof QuotaExhaustedError) break;
        c.notes.push(`comment refresh: ${(e as Error).message}`); break;
      }
      const seen = new Set<string>();
      db.transaction(() => {
        for (const it of res.items ?? []) {
          const s = it.snippet ?? {};
          seen.add(it.id);
          upd.run(s.textOriginal ?? s.textDisplay ?? "", s.likeCount ?? null, s.updatedAt ?? null, s.authorChannelId?.value ?? null, iso(now), it.id);
          c.commentsRefreshed++;
        }
      })();
      c.commentsDeleted += tombstone(db, batch.filter((id) => !seen.has(id)), "removed_on_youtube", now);
    }
  }

  // No automatic age-based erasure of videos, snapshots or comment text.
  trimCaches();
}

// ─── 2. Discovery ────────────────────────────────────────────────────────────

interface SearchSliceResult { ids: string[]; pages: number; exhausted: boolean }

async function searchSlice(yt: YouTubeClient, q: string, after: string, before: string | undefined, maxPages: number): Promise<SearchSliceResult> {
  const ids: string[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    const res = await yt.search({ q, publishedAfter: after, publishedBefore: before, pageToken: token });
    pages++;
    for (const it of res.items ?? []) if (it.id?.videoId) ids.push(it.id.videoId);
    token = res.nextPageToken;
  } while (token && pages < maxPages);
  return { ids, pages, exhausted: !token };
}

export interface CandidateVerdict { videoId: string; title: string; channelTitle: string | null; categoryId: string | null; admit: boolean; reason: string; item: any }

/** Fetch full metadata for candidate IDs and apply the title's relevance rules. */
export async function judgeCandidates(yt: YouTubeClient, t: TitleRow, ids: string[]): Promise<CandidateVerdict[]> {
  const cfg = matchConfigOf(t);
  const out: CandidateVerdict[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const res = await yt.videos(ids.slice(i, i + 50));
    for (const it of res.items ?? []) {
      const s = it.snippet ?? {};
      const m = matchVideo(cfg, { title: s.title ?? "", description: s.description, categoryId: s.categoryId });
      out.push({ videoId: it.id, title: s.title ?? "", channelTitle: s.channelTitle ?? null, categoryId: s.categoryId ?? null, admit: m.admit, reason: m.reason, item: it });
    }
  }
  return out;
}

function upsertVideoFromItem(db: YtDb, titleId: number, it: any, now: Date, extra?: { matchReason: string; via: string }) {
  const s = it.snippet ?? {}, st = it.statistics ?? {}, cd = it.contentDetails ?? {};
  const dur = parseIsoDuration(cd.duration);
  const num = (v: any) => (v === undefined || v === null ? null : Number(v));
  const row = {
    video_id: it.id, title_id: titleId, channel_id: s.channelId ?? null, channel_title: s.channelTitle ?? null,
    title: s.title ?? "", published_at: s.publishedAt ?? iso(now), duration_s: dur,
    is_short_form: isShortForm(dur, s.liveBroadcastContent) ? 1 : 0, live_broadcast: s.liveBroadcastContent ?? null,
    category_id: s.categoryId ?? null, thumbnail_url: s.thumbnails?.medium?.url ?? s.thumbnails?.default?.url ?? null,
    view_count: num(st.viewCount), like_count: num(st.likeCount),
    comment_count: num(st.commentCount), comments_disabled: st.commentCount === undefined ? 1 : 0,
    match_reason: extra?.matchReason ?? "", discovered_via: extra?.via ?? "", now: iso(now),
  };
  db.prepare(`INSERT INTO yt_videos (video_id, title_id, channel_id, channel_title, title, published_at, duration_s,
      is_short_form, live_broadcast, category_id, thumbnail_url, view_count, like_count, comment_count, comments_disabled,
      match_reason, discovered_via, first_seen_at, last_refreshed_at)
    VALUES (@video_id, @title_id, @channel_id, @channel_title, @title, @published_at, @duration_s, @is_short_form,
      @live_broadcast, @category_id, @thumbnail_url, @view_count, @like_count, @comment_count, @comments_disabled,
      @match_reason, @discovered_via, @now, @now)
    ON CONFLICT(video_id) DO UPDATE SET channel_id=excluded.channel_id, channel_title=excluded.channel_title,
      title=excluded.title, published_at=excluded.published_at, duration_s=excluded.duration_s,
      is_short_form=excluded.is_short_form, live_broadcast=excluded.live_broadcast, category_id=excluded.category_id,
      thumbnail_url=excluded.thumbnail_url, view_count=excluded.view_count, like_count=excluded.like_count,
      comment_count=excluded.comment_count, comments_disabled=excluded.comments_disabled,
      last_refreshed_at=excluded.last_refreshed_at`).run(row);
  db.prepare("UPDATE yt_videos SET relevance_version=?, excluded_at=NULL, exclusion_reason=NULL WHERE video_id=?").run(RELEVANCE_VERSION, it.id);
  db.prepare(`INSERT INTO yt_video_stats_daily (video_id, date, view_count, like_count, comment_count) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(video_id, date) DO UPDATE SET view_count=excluded.view_count, like_count=excluded.like_count, comment_count=excluded.comment_count`)
    .run(it.id, iso(now).slice(0, 10), row.view_count, row.like_count, row.comment_count);
}

async function admitCandidates(db: YtDb, yt: YouTubeClient, t: TitleRow, ids: string[], via: string, c: RunCounters, now: Date) {
  const known = new Set<string>();
  const knownStmt = db.prepare("SELECT 1 FROM yt_videos WHERE video_id=? AND excluded_at IS NULL UNION ALL SELECT 1 FROM yt_rejected_videos WHERE video_id=? AND title_id=?");
  for (const id of ids) if (knownStmt.get(id, id, t.title_id)) known.add(id);
  const fresh = Array.from(new Set(ids.filter((id) => !known.has(id))));
  if (!fresh.length) return;
  const verdicts = await judgeCandidates(yt, t, fresh);
  const rej = db.prepare(`INSERT INTO yt_rejected_videos (video_id, title_id, reason, seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(video_id, title_id) DO UPDATE SET reason=excluded.reason, seen_at=excluded.seen_at`);
  db.transaction(() => {
    for (const v of verdicts) {
      if (v.admit) { upsertVideoFromItem(db, t.title_id, v.item, now, { matchReason: v.reason, via }); c.videosDiscovered++; }
      else rej.run(v.videoId, t.title_id, v.reason, iso(now));
    }
  })();
}

export async function runDiscovery(db: YtDb, yt: YouTubeClient, c: RunCounters, opts: PipelineOptions) {
  const now = (opts.now ?? (() => new Date()))();
  const titles = db.prepare("SELECT * FROM yt_titles WHERE enabled=1 ORDER BY COALESCE(last_incremental_at,''), title_id").all() as TitleRow[];
  const hasSearch = () => quotaRemaining(db, "search") > SEARCH_RESERVE;

  // a) incremental: everything published since the last successful search (2-day overlap)
  for (const t of titles) {
    if (!hasSearch()) { c.notes.push("search reserve reached during incremental discovery"); return; }
    const after = t.last_incremental_at
      ? iso(new Date(new Date(t.last_incremental_at).getTime() - 2 * DAY))
      : iso(new Date(now.getTime() - 7 * DAY));
    try {
      const r = await searchSlice(yt, t.search_query, after, undefined, INCREMENTAL_MAX_PAGES);
      await admitCandidates(db, yt, t, r.ids, "incremental", c, now);
      db.prepare("UPDATE yt_titles SET last_incremental_at=?, backfill_oldest=COALESCE(backfill_oldest, ?) WHERE title_id=?")
        .run(iso(now), after, t.title_id);
      if (!r.exhausted) c.notes.push(`${t.title}: incremental hit ${INCREMENTAL_MAX_PAGES}-page cap`);
    } catch (e) {
      if (e instanceof QuotaExhaustedError) return;
      c.notes.push(`${t.title} incremental: ${(e as Error).message}`);
    }
  }

  // b) backfill: walk backwards in adaptive slices, round-robin across titles
  let progressed = true;
  while (progressed && hasSearch()) {
    progressed = false;
    const pending = db.prepare(`SELECT * FROM yt_titles WHERE enabled=1 AND backfill_oldest IS NOT NULL
      AND backfill_oldest > backfill_floor || 'T00:00:00.000Z' ORDER BY backfill_oldest DESC`).all() as TitleRow[] & any[];
    for (const t of pending as any[]) {
      if (!hasSearch()) break;
      const before = t.backfill_oldest as string;
      const floorIso = `${t.backfill_floor}T00:00:00.000Z`;
      const sliceDays = Math.min(90, Math.max(3, t.backfill_slice_days || 30));
      let after = iso(new Date(new Date(before).getTime() - sliceDays * DAY));
      if (after < floorIso) after = floorIso;
      try {
        const r = await searchSlice(yt, t.search_query, after, before, BACKFILL_MAX_PAGES);
        await admitCandidates(db, yt, t, r.ids, "backfill", c, now);
        const nextSlice = !r.exhausted ? Math.max(3, Math.floor(sliceDays / 2)) : r.pages <= 1 ? Math.min(90, sliceDays * 2) : sliceDays;
        db.prepare("UPDATE yt_titles SET backfill_oldest=?, backfill_slice_days=? WHERE title_id=?").run(after, nextSlice, t.title_id);
        if (!r.exhausted) c.notes.push(`${t.title}: backfill slice ${after.slice(0, 10)}→${before.slice(0, 10)} hit page cap`);
        progressed = true;
      } catch (e) {
        if (e instanceof QuotaExhaustedError) return;
        c.notes.push(`${t.title} backfill: ${(e as Error).message}`);
      }
    }
  }
}

// ─── 3. Stats refresh ────────────────────────────────────────────────────────

export async function runStatsRefresh(db: YtDb, yt: YouTubeClient, c: RunCounters, opts: PipelineOptions) {
  const now = (opts.now ?? (() => new Date()))();
  const today = iso(now).slice(0, 10);
  const titles = new Map((db.prepare("SELECT * FROM yt_titles").all() as TitleRow[]).map((t) => [t.title_id, t]));
  // Oldest-refreshed first, skipping videos already refreshed today (discovery wrote them).
  const rows = db.prepare("SELECT video_id, title_id FROM yt_videos WHERE excluded_at IS NULL AND (substr(last_refreshed_at,1,10) < ? OR relevance_version < ?) ORDER BY relevance_version, last_refreshed_at")
    .all(today, RELEVANCE_VERSION) as Array<{ video_id: string; title_id: number }>;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    let res: any;
    try { res = await yt.videos(batch.map((b) => b.video_id)); } catch (e) {
      if (e instanceof QuotaExhaustedError) { c.notes.push("units ceiling reached during stats refresh"); return; }
      c.notes.push(`stats refresh: ${(e as Error).message}`); continue;
    }
    const returned = new Map<string, any>((res.items ?? []).map((it: any) => [it.id, it]));
    db.transaction(() => {
      for (const b of batch) {
        const it = returned.get(b.video_id);
        if (!it) { c.commentsDeleted += removeVideo(db, b.video_id, "video_unavailable", now); c.videosRemoved++; continue; }
        const t = titles.get(b.title_id);
        if (t) {
          const s = it.snippet ?? {};
          const m = matchVideo(matchConfigOf(t), { title: s.title ?? "", description: s.description, categoryId: s.categoryId });
          if (!m.admit) { c.commentsDeleted += removeVideo(db, b.video_id, "no_longer_matches", now); c.videosRemoved++; continue; }
        }
        upsertVideoFromItem(db, b.title_id, it, now);
        c.videosRefreshed++;
      }
    })();
  }
}

// ─── 4. Comments ─────────────────────────────────────────────────────────────

function saveComment(db: YtDb, videoId: string, titleId: number, parentId: string | null, cm: any, now: Date): boolean {
  const s = cm.snippet ?? {};
  const r = db.prepare(`INSERT INTO yt_comments (comment_id, video_id, title_id, parent_id, author_channel_id, text,
      like_count, published_at, updated_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(comment_id) DO UPDATE SET text=excluded.text, like_count=excluded.like_count,
      updated_at=excluded.updated_at, author_channel_id=excluded.author_channel_id,
      fetched_at=excluded.fetched_at, excluded_at=NULL`)
    .run(cm.id, videoId, titleId, parentId, s.authorChannelId?.value ?? null, s.textOriginal ?? s.textDisplay ?? "",
      s.likeCount ?? null, s.publishedAt ?? iso(now), s.updatedAt ?? null, iso(now));
  return r.changes > 0;
}

async function saveThreadPage(db: YtDb, yt: YouTubeClient, v: any, res: any, c: RunCounters, now: Date, stopAt: string | null) {
  let newest: string | null = null;
  let reachedKnown = false;
  for (const th of res.items ?? []) {
    const top = th.snippet?.topLevelComment;
    if (!top) continue;
    const pub = top.snippet?.publishedAt ?? "";
    if (stopAt && pub <= stopAt) reachedKnown = true;
    if (!newest || pub > newest) newest = pub;
    if (saveComment(db, v.video_id, v.title_id, null, top, now)) c.commentsSaved++;
    const inline = th.replies?.comments ?? [];
    for (const r of inline) if (saveComment(db, v.video_id, v.title_id, top.id, r, now)) c.commentsSaved++;
    const total = th.snippet?.totalReplyCount ?? 0;
    if (total > inline.length && quotaRemaining(db, "units") > STATS_RESERVE_UNITS) {
      let token: string | undefined = (db.prepare("SELECT page_token FROM yt_reply_cursors WHERE parent_id=?").get(top.id) as any)?.page_token ?? undefined;
      let pages = 0;
      do {
        const rr = await yt.commentsByParent({ parentId: top.id, pageToken: token });
        pages++;
        for (const r of rr.items ?? []) if (saveComment(db, v.video_id, v.title_id, top.id, r, now)) c.commentsSaved++;
        token = rr.nextPageToken;
      } while (token && pages < REPLY_MAX_PAGES);
      db.prepare("INSERT INTO yt_reply_cursors(parent_id,page_token) VALUES(?,?) ON CONFLICT(parent_id) DO UPDATE SET page_token=excluded.page_token")
        .run(top.id, token ?? null);
      if (token) c.notes.push(`reply backlog for ${top.id}: continuation saved`);
    }
  }
  return { newest, reachedKnown };
}

export async function runComments(db: YtDb, yt: YouTubeClient, c: RunCounters, opts: PipelineOptions) {
  const now = (opts.now ?? (() => new Date()))();
  const spendable = () => quotaRemaining(db, "units") > STATS_RESERVE_UNITS;
  // Poll daily even when the total is unchanged: one deletion plus one new
  // comment leaves the same total. Oldest-polled first prevents starvation.
  const vids = db.prepare(`SELECT * FROM yt_videos WHERE excluded_at IS NULL AND relevance_version=${RELEVANCE_VERSION} AND comments_disabled=0 AND COALESCE(comment_count,0) > 0
      AND (comments_polled_at IS NULL OR substr(comments_polled_at,1,10) < ? OR comments_incremental_token IS NOT NULL)
    ORDER BY COALESCE(comments_polled_at,''), title_id, video_id`).all(iso(now).slice(0, 10)) as any[];
  for (const v of vids) {
    if (!spendable()) { c.notes.push("units reserve reached during comment collection"); return; }
    try {
      let token: string | undefined = v.comments_incremental_token ?? undefined;
      let pages = 0; let newestSeen: string | null = v.comments_incremental_newest; let stop = false;
      do {
        const res = await yt.commentThreads({ videoId: v.video_id, pageToken: token });
        pages++;
        const r = await saveThreadPage(db, yt, v, res, c, now, v.comments_newest_at);
        if (r.newest && (!newestSeen || r.newest > newestSeen)) newestSeen = r.newest;
        token = res.nextPageToken;
        stop = r.reachedKnown;
      } while (token && !stop && pages < COMMENT_NEW_MAX_PAGES && spendable());
      const firstPoll = !v.comments_newest_at;
      const gapPending = !firstPoll && !!token && !stop;
      if (gapPending) c.notes.push(`${v.video_id}: new-comment continuation saved`);
      db.prepare(`UPDATE yt_videos SET comments_newest_at=COALESCE(?, comments_newest_at), comments_polled_at=?,
          comments_count_at_poll=comment_count,
          comments_incremental_token=?, comments_incremental_newest=?,
          comments_backfill_token=CASE WHEN ? THEN ? ELSE comments_backfill_token END,
          comments_backfill_done=CASE WHEN ? THEN ? ELSE comments_backfill_done END WHERE video_id=?`)
        .run(gapPending ? null : newestSeen, iso(now), gapPending ? token : null, gapPending ? newestSeen : null,
          firstPoll ? 1 : 0, token ?? null, firstPoll ? 1 : 0, token ? 0 : 1, v.video_id);
    } catch (e) {
      if (e instanceof QuotaExhaustedError) return;
      if (e instanceof YouTubeApiError && e.reason === "commentsDisabled") {
        db.prepare("UPDATE yt_videos SET comments_disabled=1, comments_polled_at=? WHERE video_id=?").run(iso(now), v.video_id);
        continue;
      }
      if (e instanceof YouTubeApiError && e.status === 404) continue; // stats pass will archive
      if (e instanceof YouTubeApiError && e.status === 400 && v.comments_incremental_token) {
        db.prepare("UPDATE yt_videos SET comments_incremental_token=NULL, comments_incremental_newest=NULL WHERE video_id=?").run(v.video_id);
      }
      c.notes.push(`comments ${v.video_id}: ${(e as Error).message}`);
    }
  }
  // Rotate through older threads too: new replies can land under old comments.
  // Reset a completed sweep, otherwise continue its durable page token.
  const back = db.prepare(`SELECT * FROM yt_videos WHERE excluded_at IS NULL AND relevance_version=${RELEVANCE_VERSION}
      AND comments_disabled=0 AND COALESCE(comment_count,0)>0
      ORDER BY COALESCE(comments_backfill_polled_at,''),title_id,video_id`).all() as any[];
  for (const v of back) {
    if (!spendable()) return;
    try {
      let token: string | undefined = v.comments_backfill_token; let pages = 0;
      do {
        const res = await yt.commentThreads({ videoId: v.video_id, pageToken: token });
        pages++;
        await saveThreadPage(db, yt, v, res, c, now, null);
        token = res.nextPageToken;
      } while (token && pages < COMMENT_BACKFILL_MAX_PAGES && spendable());
      db.prepare("UPDATE yt_videos SET comments_backfill_token=?, comments_backfill_done=? WHERE video_id=?")
        .run(token ?? null, token ? 0 : 1, v.video_id);
    } catch (e) {
      if (e instanceof QuotaExhaustedError) return;
      // A transient failure must not skip the remaining history.
      if (e instanceof YouTubeApiError && e.status === 400) {
        db.prepare("UPDATE yt_videos SET comments_backfill_token=NULL, comments_backfill_done=0 WHERE video_id=?").run(v.video_id);
      }
      c.notes.push(`comment backfill ${v.video_id}: ${(e as Error).message}`);
    } finally {
      db.prepare("UPDATE yt_videos SET comments_backfill_polled_at=? WHERE video_id=?").run(iso(now), v.video_id);
    }
  }
}

// ─── Orchestration ───────────────────────────────────────────────────────────

let running = false;
export function isYoutubeRunActive() { return running; }

export async function runYoutubePipeline(db: YtDb, apiKey: string | null, trigger: string, opts: PipelineOptions) {
  if (running) return { status: "skipped", message: "a YouTube run is already in progress" };
  running = true;
  const started = new Date();
  const runId = Number(db.prepare("INSERT INTO yt_ingest_runs (trigger, started_at, status) VALUES (?, ?, 'running')").run(trigger, iso(started)).lastInsertRowid);
  const c: RunCounters = { searchCalls: 0, units: 0, videosDiscovered: 0, videosRefreshed: 0, videosRemoved: 0, commentsSaved: 0, commentsRefreshed: 0, commentsDeleted: 0, notes: [] };
  const steps = opts.steps ?? ["retention", "discovery", "stats", "comments"];
  let status = "success";
  const yt = apiKey ? new YouTubeClient(db, apiKey) : null;
  try {
    if (steps.includes("retention")) await runRetention(db, yt, c, opts);
    if (!yt) { status = "skipped"; c.notes.push("youtube_api_key is not set; only retention ran"); }
    else {
      if (steps.includes("discovery")) await runDiscovery(db, yt, c, opts);
      if (steps.includes("stats")) await runStatsRefresh(db, yt, c, opts);
      if (steps.includes("comments")) await runComments(db, yt, c, opts);
      if (c.notes.length) status = "partial";
    }
  } catch (e) {
    status = "failed";
    c.notes.push((e as Error).message);
  } finally {
    if (yt) { c.searchCalls = yt.counters.searchCalls; c.units = yt.counters.units; }
    db.prepare(`UPDATE yt_ingest_runs SET finished_at=?, status=?, search_calls=?, units_used=?, videos_discovered=?,
        videos_refreshed=?, videos_removed=?, comments_saved=?, comments_refreshed=?, comments_deleted=?, message=? WHERE id=?`)
      .run(iso(new Date()), status, c.searchCalls, c.units, c.videosDiscovered, c.videosRefreshed, c.videosRemoved,
        c.commentsSaved, c.commentsRefreshed, c.commentsDeleted, c.notes.slice(0, 40).join(" | ").slice(0, 4000), runId);
    running = false;
  }
  return { status, runId, ...c };
}
