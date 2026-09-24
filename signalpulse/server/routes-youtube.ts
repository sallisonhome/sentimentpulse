/**
 * YouTube Pulse API (v1.0, 2026-09-24).
 *
 * Authenticated (Saber JWT, like the rest of the SPA):
 *   GET  /api/youtube/leaderboard?window=d1|d7|d30|d90|m12|ltd&sort=views|videos|shortForm|comments|likes|likesPct|title&direction=desc|asc
 *        Cohort definition: videos PUBLISHED in the window, current lifetime stats.
 *   GET  /api/youtube/titles/:titleId/videos?window=…&limit=…
 *   GET  /api/youtube/status          quota use, last runs, row counts
 *   GET  /api/youtube/lookup?q=<game name>&strict=0|1&refresh=0|1
 *        One-off lookup for any game (e.g. a competitor not tracked): the same
 *        cohort metrics for videos published in the last 24h / 7d / 30d.
 *        ≤3 search calls, cached 6h, never added to tracking.
 *
 * Ops-token (x-ops-token = INGESTION_OPS_TOKEN) — see saber-auth.ts OPS_TOKEN_PREFIXES:
 *   POST /api/youtube/ops/run                       body {steps?: string[]}
 *   GET  /api/youtube/ops/relevance-dryrun?titleId=…   1 search call, nothing persisted
 *   GET  /api/youtube/ops/comments-feed?since=ISO&cursor=…&limit=…&steamAppId=…
 *        Comment feed for SentimentPulse: comments whose text was fetched or
 *        refreshed after `since`, plus tombstones for comments deleted since.
 *        Consumers must apply tombstones (comments removed on YouTube). In
 *        retention mode "policy30" they must also drop comment text 30 days
 *        after `fetchedAt`; the default mode "unlimited" has no age limit.
 */
import type { Express, Request, Response } from "express";
import { storage } from "./storage";
import { ytDb } from "./youtube/db";
import { COHORT_WINDOWS, COHORT_SORTS, computeCohortLeaderboard, listTitleVideos, type CohortWindow, type CohortSort } from "./youtube/cohort";
import { quotaUsed, ptDate, SEARCH_CALLS_CEILING, UNITS_CEILING, YouTubeClient, QuotaExhaustedError } from "./youtube/api";
import { runYoutubePipeline, isYoutubeRunActive, judgeCandidates, type RetentionMode } from "./youtube/pipeline";
import { syncTitles, buildTitleSources, type TitleRow, type SentimentPulseGameLite } from "./youtube/titles";
import { listSentimentPulseGames, listCompetitorsForParent } from "./sentimentpulse-client";
import { log } from "./log";
import { runLookup, LookupQuotaError } from "./youtube/lookup";

export function youtubeApiKey(): string | null {
  const v = storage.getSetting("youtube_api_key")?.value?.trim();
  return v || process.env.YOUTUBE_API_KEY?.trim() || null;
}

/** "unlimited" (default) keeps API data indefinitely; "policy30" enforces the 30-day rule. */
export function youtubeRetentionMode(): RetentionMode {
  return storage.getSetting("youtube_retention_mode")?.value === "policy30" ? "policy30" : "unlimited";
}

export function extendedStorageApproved(): boolean {
  return storage.getSetting("youtube_extended_storage_approved")?.value === "true";
}

const TITLE_SYNC_TTL_MS = 15 * 60_000;
let lastTitleSync = 0;
let titleSyncInFlight: Promise<{ titles: number; sentimentpulse: boolean }> | null = null;

/**
 * Title universe = every active SentimentPulse game (Saber + competitor
 * children) ∪ SignalPulse products. If SentimentPulse is unreachable, only
 * SignalPulse products are upserted and nothing is disabled, so a transient
 * outage never drops competitor titles from collection.
 */
export async function syncYoutubeTitles(force = false): Promise<{ titles: number; sentimentpulse: boolean }> {
  if (!force && Date.now() - lastTitleSync < TITLE_SYNC_TTL_MS) return { titles: 0, sentimentpulse: true };
  if (titleSyncInFlight) return titleSyncInFlight;
  titleSyncInFlight = (async () => {
    const products = storage.getAllProducts().map((p: any) => ({ id: p.id, title: p.title, steamAppId: p.steamAppId ?? null, releaseDate: p.releaseDate ?? null }));
    let games: SentimentPulseGameLite[] | null = null;
    const competitorParent = new Map<number, number>();
    try {
      games = (await listSentimentPulseGames()) as unknown as SentimentPulseGameLite[];
      for (const g of games) for (const c of await listCompetitorsForParent(g.id)) competitorParent.set(c.id, g.id);
    } catch (e) {
      log(`youtube title sync: SentimentPulse unavailable, keeping existing titles (${e})`, "youtube");
      games = null;
    }
    const n = syncTitles(ytDb(), buildTitleSources(products, games, competitorParent), new Date(), games !== null);
    lastTitleSync = Date.now();
    return { titles: n, sentimentpulse: games !== null };
  })().finally(() => { titleSyncInFlight = null; });
  return titleSyncInFlight;
}

export async function triggerYoutubeRun(trigger: string, steps?: any[]) {
  await syncYoutubeTitles(true);
  const res = await runYoutubePipeline(ytDb(), youtubeApiKey(), trigger, { retentionMode: youtubeRetentionMode(), extendedStorageApproved: extendedStorageApproved(), steps });
  log(`youtube run (${trigger}): ${JSON.stringify({ ...res, notes: undefined })}`, "youtube");
  return res;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
}

export function registerYoutubeRoutes(app: Express) {
  app.get("/api/youtube/leaderboard", async (req: Request, res: Response) => {
    try {
      await syncYoutubeTitles().catch(() => undefined);
      const scope = req.query.scope === "all" ? "all" : "saber";
      const window = pick<CohortWindow>(req.query.window, COHORT_WINDOWS, "d1");
      const sort = pick<CohortSort>(req.query.sort, COHORT_SORTS, "views");
      const direction = req.query.direction === "asc" ? "asc" : "desc";
      const rows = computeCohortLeaderboard(ytDb(), window, sort, direction, new Date(), scope);
      const headers = new Map(storage.getAllProducts().filter((p: any) => p.steamAppId).map((p: any) => [Number(p.steamAppId), p.steamHeaderImageUrl ?? null]));
      const lastRun = ytDb().prepare("SELECT * FROM yt_ingest_runs WHERE status != 'running' ORDER BY id DESC LIMIT 1").get() ?? null;
      res.json({
        definition: "cohort",
        window, sort, direction, scope,
        generatedAt: new Date().toISOString(),
        apiKeyConfigured: !!youtubeApiKey(),
        lastRun,
        rows: rows.map((r) => ({ ...r, headerImageUrl: headers.get(r.titleId) ?? `https://cdn.cloudflare.steamstatic.com/steam/apps/${r.titleId}/header.jpg` })),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  let lookupBusy = false;
  app.get("/api/youtube/lookup", async (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (lookupBusy) return res.status(429).json({ error: "another lookup is running; try again in a few seconds" });
    lookupBusy = true;
    try {
      const key = youtubeApiKey();
      const result = await runLookup(ytDb(), key ? new YouTubeClient(ytDb(), key) : null, q, {
        strict: req.query.strict === "1" || req.query.strict === "true",
        refresh: req.query.refresh === "1" || req.query.refresh === "true",
      });
      res.json(result);
    } catch (e) {
      if (e instanceof LookupQuotaError || e instanceof QuotaExhaustedError) {
        return res.status(429).json({ error: "today's YouTube search quota is used up; it resets at midnight Pacific (03:00 ET)" });
      }
      const status = /at least 3/.test((e as Error).message) ? 400 : 502;
      res.status(status).json({ error: (e as Error).message });
    } finally {
      lookupBusy = false;
    }
  });

  app.get("/api/youtube/titles/:titleId/videos", (req: Request, res: Response) => {
    const titleId = Number(req.params.titleId);
    if (!Number.isInteger(titleId) || titleId < 1) return res.status(400).json({ error: "invalid titleId" });
    const window = pick<CohortWindow>(req.query.window, COHORT_WINDOWS, "d1");
    const limit = Math.min(250, Math.max(1, Number(req.query.limit) || 50));
    res.json({ titleId, window, videos: listTitleVideos(ytDb(), titleId, window, limit) });
  });

  app.get("/api/youtube/status", (_req: Request, res: Response) => {
    const db = ytDb();
    const count = (sql: string) => (db.prepare(sql).get() as any).n as number;
    res.json({
      apiKeyConfigured: !!youtubeApiKey(),
      retentionMode: youtubeRetentionMode(),
      extendedStorageApproved: extendedStorageApproved(),
      running: isYoutubeRunActive(),
      quota: { ptDate: ptDate(), searchUsed: quotaUsed(db, "search"), searchCeiling: SEARCH_CALLS_CEILING, unitsUsed: quotaUsed(db, "units"), unitsCeiling: UNITS_CEILING },
      counts: {
        titles: count("SELECT COUNT(*) n FROM yt_titles WHERE enabled=1"),
        videos: count("SELECT COUNT(*) n FROM yt_videos"),
        comments: count("SELECT COUNT(*) n FROM yt_comments"),
        oldestCommentFetch: (db.prepare("SELECT MIN(fetched_at) m FROM yt_comments").get() as any).m,
      },
      titles: db.prepare(`SELECT t.title_id, t.title, t.search_query, t.backfill_floor, t.backfill_oldest, t.last_incremental_at,
          (SELECT COUNT(*) FROM yt_videos v WHERE v.title_id=t.title_id) AS videos,
          (SELECT COUNT(*) FROM yt_comments c WHERE c.title_id=t.title_id) AS comments
        FROM yt_titles t WHERE t.enabled=1 ORDER BY t.title`).all(),
      runs: db.prepare("SELECT * FROM yt_ingest_runs ORDER BY id DESC LIMIT 10").all(),
    });
  });

  app.post("/api/youtube/ops/run", (req: Request, res: Response) => {
    if (isYoutubeRunActive()) return res.status(409).json({ error: "a YouTube run is already in progress" });
    const allowed = ["retention", "discovery", "stats", "comments"];
    const steps = Array.isArray(req.body?.steps) ? req.body.steps.filter((s: any) => allowed.includes(s)) : undefined;
    // Respond immediately; the run records itself in yt_ingest_runs.
    triggerYoutubeRun("manual", steps).catch((e) => log(`youtube manual run failed: ${e}`, "youtube"));
    res.status(202).json({ accepted: true, steps: steps ?? allowed });
  });

  app.get("/api/youtube/ops/relevance-dryrun", async (req: Request, res: Response) => {
    const key = youtubeApiKey();
    if (!key) return res.status(400).json({ error: "youtube_api_key is not set" });
    await syncYoutubeTitles();
    const t = ytDb().prepare("SELECT * FROM yt_titles WHERE title_id=?").get(Number(req.query.titleId)) as TitleRow | undefined;
    if (!t) return res.status(404).json({ error: "unknown titleId" });
    try {
      const yt = new YouTubeClient(ytDb(), key);
      const after = typeof req.query.publishedAfter === "string" ? req.query.publishedAfter : new Date(Date.now() - 30 * 86_400_000).toISOString();
      const s = await yt.search({ q: t.search_query, publishedAfter: after });
      const ids = (s.items ?? []).map((i: any) => i.id?.videoId).filter(Boolean);
      const verdicts = await judgeCandidates(yt, t, ids);
      res.json({
        titleId: t.title_id, title: t.title, searchQuery: t.search_query, publishedAfter: after,
        admitted: verdicts.filter((v) => v.admit).map(({ item, ...v }) => v),
        rejected: verdicts.filter((v) => !v.admit).map(({ item, ...v }) => v),
        quota: yt.counters,
      });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  app.get("/api/youtube/ops/comments-feed", (req: Request, res: Response) => {
    const db = ytDb();
    const since = typeof req.query.since === "string" && !Number.isNaN(Date.parse(req.query.since)) ? new Date(req.query.since).toISOString() : "1970-01-01T00:00:00.000Z";
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : "";
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
    const steamAppId = typeof req.query.steamAppId === "string" ? req.query.steamAppId : null;
    // Keyset pagination on (fetched_at, comment_id); cursor = "<fetched_at>|<comment_id>".
    const [cFetched, cId] = cursor.includes("|") ? cursor.split("|") : [since, ""];
    const rows = db.prepare(`SELECT c.comment_id, c.video_id, c.parent_id, c.author_channel_id, c.text, c.like_count,
        c.published_at, c.updated_at, c.fetched_at, v.title AS video_title, v.channel_title, v.published_at AS video_published_at,
        t.title_id, t.title AS product_title, t.steam_app_id
      FROM yt_comments c JOIN yt_videos v ON v.video_id=c.video_id JOIN yt_titles t ON t.title_id=c.title_id
      WHERE (c.fetched_at > ? OR (c.fetched_at = ? AND c.comment_id > ?))
        AND (? IS NULL OR t.steam_app_id = ?)
      ORDER BY c.fetched_at, c.comment_id LIMIT ?`).all(cFetched, cFetched, cId, steamAppId, steamAppId, limit) as any[];
    const tombstones = cursor ? [] : db.prepare(`SELECT tb.comment_id, tb.reason, tb.deleted_at, t.steam_app_id FROM yt_comment_tombstones tb
        LEFT JOIN yt_titles t ON t.title_id=tb.title_id
      WHERE tb.deleted_at > ? AND (? IS NULL OR t.steam_app_id = ?) ORDER BY tb.deleted_at`).all(since, steamAppId, steamAppId);
    const last = rows[rows.length - 1];
    res.json({
      source: "youtube_comment",
      since,
      retention: youtubeRetentionMode() === "policy30"
        ? { mode: "policy30", maxTextAgeDays: 30, basis: "fetchedAt", policy: "https://developers.google.com/youtube/terms/developer-policies" }
        : { mode: "unlimited", maxTextAgeDays: null },
      comments: rows.map((r) => ({
        commentId: r.comment_id,
        url: `https://www.youtube.com/watch?v=${r.video_id}&lc=${r.comment_id}`,
        videoId: r.video_id, videoTitle: r.video_title, channelTitle: r.channel_title, videoPublishedAt: r.video_published_at,
        parentId: r.parent_id, authorChannelId: r.author_channel_id, text: r.text, likeCount: r.like_count,
        publishedAt: r.published_at, updatedAt: r.updated_at, fetchedAt: r.fetched_at,
        titleId: r.title_id, productTitle: r.product_title, steamAppId: r.steam_app_id,
      })),
      tombstones,
      nextCursor: rows.length === limit && last ? `${last.fetched_at}|${last.comment_id}` : null,
    });
  });
}
