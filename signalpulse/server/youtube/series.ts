/**
 * Publication/activity history versus observed snapshots, never conflated.
 * Missing snapshots/deltas are null, not zero. Net changes compare the SAME
 * videos on consecutive UTC dates; newly discovered videos cannot create
 * fictitious daily growth. Negative corrections remain negative.
 */
import type { YtDb } from "./db";
import { RELEVANCE_VERSION } from "./relevance";
import type { YoutubeBucket, YoutubeSeries, YoutubeSeriesPoint } from "../../shared/youtube-series";

const DAY = 86_400_000;
export class SeriesInputError extends Error {}
export class SeriesNotFoundError extends Error {}
function validDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s;
}
export function readYoutubeSeries(db: YtDb, titleId: number,
  input: { start?: string; end?: string; bucket?: string; includeArchived?: boolean }, now = new Date()): YoutubeSeries {
  if (!Number.isSafeInteger(titleId) || titleId < 1) throw new SeriesInputError("Invalid title ID");
  const t = db.prepare(`SELECT t.*, p.title AS parent_title FROM yt_titles t
    LEFT JOIN yt_titles p ON p.title_id=t.parent_title_id WHERE t.title_id=?`).get(titleId) as any;
  if (!t) throw new SeriesNotFoundError("Title not found");
  const today = now.toISOString().slice(0, 10);
  const end = input.end ?? today;
  const start = input.start ?? new Date(now.getTime() - 29 * DAY).toISOString().slice(0, 10);
  const bucket = (input.bucket ?? "day") as YoutubeBucket;
  if (!validDate(start) || !validDate(end)) throw new SeriesInputError("Use valid YYYY-MM-DD dates");
  if (start > end) throw new SeriesInputError("Start date must be on or before end date");
  if (end > today) throw new SeriesInputError("End date cannot be in the future");
  if ((Date.parse(end) - Date.parse(start)) / DAY > 7305) throw new SeriesInputError("Select a range of 20 years or less");
  if (!["day", "week", "month"].includes(bucket)) throw new SeriesInputError("Bucket must be day, week or month");
  const includeArchived = !!input.includeArchived;
  const eligible = includeArchived
    ? `(v.relevance_version=${RELEVANCE_VERSION} OR v.excluded_at IS NOT NULL)`
    : `v.relevance_version=${RELEVANCE_VERSION} AND v.excluded_at IS NULL`;
  const upper = new Date(Date.parse(end) + DAY).toISOString();
  const lower = `${start}T00:00:00.000Z`;
  const publications = db.prepare(`SELECT substr(v.published_at,1,10) date, COUNT(*) n, SUM(v.is_short_form) shorts
    FROM yt_videos v WHERE v.title_id=? AND ${eligible} AND v.published_at>=? AND v.published_at<?
    GROUP BY substr(v.published_at,1,10)`).all(titleId, lower, upper) as any[];
  const comments = db.prepare(`SELECT substr(c.published_at,1,10) date, COUNT(*) n FROM yt_comments c
    JOIN yt_videos v ON v.video_id=c.video_id WHERE v.title_id=? AND ${eligible}
    AND (?=1 OR c.excluded_at IS NULL) AND c.published_at>=? AND c.published_at<?
    GROUP BY substr(c.published_at,1,10)`).all(titleId, Number(includeArchived), lower, upper) as any[];
  const snapshots = db.prepare(`SELECT s.date, COUNT(*) videos, COUNT(s.comment_count) known_comments,
    SUM(s.comment_count) comments, SUM(s.view_count) views
    FROM yt_video_stats_daily s JOIN yt_videos v ON v.video_id=s.video_id
    WHERE v.title_id=? AND ${eligible} AND s.date>=? AND s.date<=? GROUP BY s.date`)
    .all(titleId, start, end) as any[];
  const deltas = db.prepare(`SELECT s.date, COUNT(*) matched,
    SUM(CASE WHEN s.view_count IS NOT NULL AND p.view_count IS NOT NULL THEN s.view_count-p.view_count END) views,
    SUM(CASE WHEN s.comment_count IS NOT NULL AND p.comment_count IS NOT NULL THEN s.comment_count-p.comment_count END) comments
    FROM yt_video_stats_daily s JOIN yt_video_stats_daily p
      ON p.video_id=s.video_id AND p.date=date(s.date,'-1 day')
    JOIN yt_videos v ON v.video_id=s.video_id
    WHERE v.title_id=? AND ${eligible} AND s.date>=? AND s.date<=? GROUP BY s.date`)
    .all(titleId, start, end) as any[];
  const byDate = (rows: any[]) => new Map(rows.map(r => [r.date, r]));
  const pub = byDate(publications), com = byDate(comments), snap = byDate(snapshots), delta = byDate(deltas);
  const daily: YoutubeSeriesPoint[] = [];
  for (let at = Date.parse(start); at <= Date.parse(end); at += DAY) {
    const date = new Date(at).toISOString().slice(0, 10), s = snap.get(date), d = delta.get(date);
    daily.push({ date, endDate: date, publishedVideos: pub.get(date)?.n ?? 0, shortFormVideos: pub.get(date)?.shorts ?? 0,
      collectedComments: com.get(date)?.n ?? 0, snapshotVideos: s?.videos ?? null,
      knownCommentVideos: s?.known_comments ?? null, snapshotComments: s?.comments ?? null, snapshotViews: s?.views ?? null,
      matchedVideos: d?.matched ?? null, netViews: d?.views ?? null, netComments: d?.comments ?? null });
  }
  const groups = new Map<string, YoutubeSeriesPoint[]>();
  for (const row of daily) {
    const d = new Date(row.date);
    if (bucket === "week") d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    const key = bucket === "month" ? row.date.slice(0, 7) : bucket === "week" ? d.toISOString().slice(0, 10) : row.date;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const sumDelta = (rows: YoutubeSeriesPoint[], k: "netViews" | "netComments" | "matchedVideos") =>
    rows.some(r => r[k] == null) ? null : rows.reduce((n, r) => n + r[k]!, 0);
  const rows = Array.from(groups.values()).map((g: YoutubeSeriesPoint[]) => ({ ...g[g.length - 1], date: g[0].date,
    publishedVideos: g.reduce((n: number, r: YoutubeSeriesPoint) => n + r.publishedVideos, 0),
    shortFormVideos: g.reduce((n: number, r: YoutubeSeriesPoint) => n + r.shortFormVideos, 0),
    collectedComments: g.reduce((n: number, r: YoutubeSeriesPoint) => n + r.collectedComments, 0),
    netViews: sumDelta(g, "netViews"), netComments: sumDelta(g, "netComments"),
    // Video-day pairs, not a distinct video count, when bucket > day.
    matchedVideos: sumDelta(g, "matchedVideos"),
  }));
  const history = db.prepare(`SELECT MIN(s.date) first, MAX(s.date) last FROM yt_video_stats_daily s
    JOIN yt_videos v ON v.video_id=s.video_id WHERE v.title_id=? AND ${eligible}`).get(titleId) as any;
  const retained = db.prepare(`SELECT COUNT(*) n, SUM(excluded_at IS NOT NULL) archived FROM yt_videos WHERE title_id=?`).get(titleId) as any;
  const retainedComments = (db.prepare("SELECT COUNT(*) n FROM yt_comments WHERE title_id=?").get(titleId) as any).n;
  return { titleId, title: t.title, isSaber: !!t.is_saber, parentTitle: t.parent_title ?? null,
    start, end, bucket, timezone: "UTC", includeArchived, generatedAt: now.toISOString(),
    firstSnapshot: history.first, lastSnapshot: history.last,
    retainedVideos: retained.n, archivedVideos: retained.archived ?? 0, retainedComments, rows };
}
