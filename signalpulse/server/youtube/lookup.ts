/**
 * YouTube Pulse — one-off game lookup (search box on the YouTube page).
 *
 * Returns the same cohort metrics the leaderboard shows for tracked titles
 * (views, videos, short-form ≤3 min, comments, likes, likes % of views) for
 * any game name, over videos PUBLISHED in the last 24h / 7d / 30d. Nothing is
 * added to the tracked-title universe, the leaderboard or the comment feed.
 *
 * Relevance mirrors tracked titles: the typed name must appear in the video
 * title; default (non-strict) needs Gaming category OR a game-context term;
 * strict needs both (use it for names that are also films/common words).
 *
 * Cost: ≤ LOOKUP_MAX_PAGES search calls (search bucket, 100/day) + 1 unit per
 * 50 candidates. Results are cached for LOOKUP_CACHE_HOURS per (name, strict).
 * Coverage: search.list returns at most ~500 results per query and is not
 * exhaustive, so very large titles are a lower bound (flagged in `coverage`).
 */
import type { YtDb } from "./db";
import { YouTubeClient, quotaRemaining } from "./api";
import { matchVideo, normalize, parseIsoDuration, isShortForm, type TitleMatchConfig } from "./relevance";

export const LOOKUP_MAX_PAGES = 3;
export const LOOKUP_CACHE_HOURS = 6;
export const LOOKUP_DAYS = 30;

export interface LookupVideo {
  videoId: string; url: string; title: string; channelTitle: string | null; publishedAt: string;
  durationS: number | null; isShortForm: boolean; views: number | null; likes: number | null; comments: number | null;
  matchReason: string;
}
export interface LookupWindow {
  views: number; videos: number; shortForm: number; comments: number; likes: number;
  likesPct: number | null; likesHiddenVideos: number; commentsDisabledVideos: number;
}
export interface LookupResult {
  query: string; strict: boolean; searchQuery: string; days: number;
  createdAt: string; cached: boolean;
  windows: { d1: LookupWindow; d7: LookupWindow; d30: LookupWindow };
  topVideos: LookupVideo[];
  admitted: number; rejected: number;
  rejectedSamples: Array<{ videoId: string; title: string; channelTitle: string | null; reason: string }>;
  coverage: { searchPages: number; candidates: number; exhausted: boolean };
  quota: { searchCalls: number; units: number };
  trackedTitle: { titleId: number; title: string } | null;
}

export function lookupConfig(query: string, strict: boolean): TitleMatchConfig {
  return { phrases: [query], excludeTerms: [], requireCompanion: strict };
}

export function aggregateLookup(videos: LookupVideo[], now: Date): LookupResult["windows"] {
  const agg = (hours: number): LookupWindow => {
    const start = new Date(now.getTime() - hours * 3600_000).toISOString();
    const vs = videos.filter((v) => v.publishedAt >= start);
    const withLikes = vs.filter((v) => v.likes != null);
    const likes = withLikes.reduce((a, v) => a + (v.likes ?? 0), 0);
    const viewsWithLikes = withLikes.reduce((a, v) => a + (v.views ?? 0), 0);
    return {
      views: vs.reduce((a, v) => a + (v.views ?? 0), 0),
      videos: vs.length,
      shortForm: vs.filter((v) => v.isShortForm).length,
      comments: vs.reduce((a, v) => a + (v.comments ?? 0), 0),
      likes,
      likesPct: viewsWithLikes > 0 ? (likes / viewsWithLikes) * 100 : null,
      likesHiddenVideos: vs.length - withLikes.length,
      commentsDisabledVideos: vs.filter((v) => v.comments == null).length,
    };
  };
  return { d1: agg(24), d7: agg(24 * 7), d30: agg(24 * LOOKUP_DAYS) };
}

export class LookupQuotaError extends Error {}

export async function runLookup(db: YtDb, yt: YouTubeClient | null, rawQuery: string,
  opts: { strict?: boolean; refresh?: boolean; now?: Date } = {}): Promise<LookupResult> {
  const query = rawQuery.trim().replace(/\s+/g, " ").slice(0, 120);
  const qn = normalize(query);
  if (qn.length < 3) throw new Error("enter at least 3 characters");
  const strict = !!opts.strict;
  const now = opts.now ?? new Date();

  if (!opts.refresh) {
    const since = new Date(now.getTime() - LOOKUP_CACHE_HOURS * 3600_000).toISOString();
    const hit = db.prepare("SELECT result_json FROM yt_lookups WHERE query_norm=? AND strict=? AND created_at >= ? ORDER BY id DESC LIMIT 1")
      .get(qn, strict ? 1 : 0, since) as { result_json: string } | undefined;
    if (hit) return { ...(JSON.parse(hit.result_json) as LookupResult), cached: true };
  }
  if (!yt) throw new Error("youtube_api_key is not set");
  if (quotaRemaining(db, "search", now) < 1) throw new LookupQuotaError("today's YouTube search quota is used up; it resets at midnight Pacific (03:00 ET)");

  const tracked = (db.prepare("SELECT title_id, title, phrases FROM yt_titles WHERE enabled=1").all() as any[])
    .find((t) => (JSON.parse(t.phrases) as string[]).some((p) => normalize(p) === qn) || normalize(t.title) === qn);

  const searchQuery = `"${query}"`;
  const after = new Date(now.getTime() - LOOKUP_DAYS * 86_400_000).toISOString();
  const ids: string[] = [];
  let token: string | undefined; let pages = 0;
  do {
    if (pages > 0 && quotaRemaining(db, "search", now) < 1) break;
    const r = await yt.search({ q: searchQuery, publishedAfter: after, pageToken: token });
    pages++;
    for (const it of r.items ?? []) if (it.id?.videoId) ids.push(it.id.videoId);
    token = r.nextPageToken;
  } while (token && pages < LOOKUP_MAX_PAGES);

  const cfg = lookupConfig(query, strict);
  const unique = Array.from(new Set(ids));
  const admitted: LookupVideo[] = [];
  const rejected: LookupResult["rejectedSamples"] = [];
  for (let i = 0; i < unique.length; i += 50) {
    const res = await yt.videos(unique.slice(i, i + 50));
    for (const it of res.items ?? []) {
      const s = it.snippet ?? {}, st = it.statistics ?? {}, cd = it.contentDetails ?? {};
      const m = matchVideo(cfg, { title: s.title ?? "", description: s.description, categoryId: s.categoryId });
      if (!m.admit) { rejected.push({ videoId: it.id, title: s.title ?? "", channelTitle: s.channelTitle ?? null, reason: m.reason }); continue; }
      const dur = parseIsoDuration(cd.duration);
      const num = (v: any) => (v === undefined || v === null ? null : Number(v));
      admitted.push({
        videoId: it.id, url: `https://www.youtube.com/watch?v=${it.id}`, title: s.title ?? "", channelTitle: s.channelTitle ?? null,
        publishedAt: s.publishedAt ?? now.toISOString(), durationS: dur, isShortForm: isShortForm(dur, s.liveBroadcastContent),
        views: num(st.viewCount), likes: num(st.likeCount), comments: num(st.commentCount), matchReason: m.reason,
      });
    }
  }
  admitted.sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const result: LookupResult = {
    query, strict, searchQuery, days: LOOKUP_DAYS, createdAt: now.toISOString(), cached: false,
    windows: aggregateLookup(admitted, now),
    topVideos: admitted.slice(0, 25),
    admitted: admitted.length, rejected: rejected.length, rejectedSamples: rejected.slice(0, 15),
    coverage: { searchPages: pages, candidates: unique.length, exhausted: !token },
    quota: { ...yt.counters },
    trackedTitle: tracked ? { titleId: tracked.title_id, title: tracked.title } : null,
  };
  db.prepare("INSERT INTO yt_lookups (query_norm, query, strict, created_at, result_json) VALUES (?, ?, ?, ?, ?)")
    .run(qn, query, strict ? 1 : 0, result.createdAt, JSON.stringify(result));
  db.prepare("DELETE FROM yt_lookups WHERE created_at < ?").run(new Date(now.getTime() - 30 * 86_400_000).toISOString());
  return result;
}
