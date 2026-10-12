/**
 * TikTok Pulse API (v1.0, 2026-10-12).
 *
 * Authenticated (Saber JWT, like the rest of the SPA):
 *   GET  /api/tiktok/leaderboard?window=d1|d7|d30|d90|m12|ltd&sort=views|videos|comments|likes|likesPct|reposts|title&direction=desc|asc
 *        Cohort definition: videos PUBLISHED (create_time) in the window, current lifetime stats.
 *   GET  /api/tiktok/titles/:titleId/videos?window=…&limit=…
 *   GET  /api/tiktok/titles/:titleId/timeseries[.csv]?start=…&end=…&bucket=day|week|month
 *   GET  /api/tiktok/status          quota use, last runs, row counts
 *
 * Ops-token (x-ops-token = INGESTION_OPS_TOKEN):
 *   POST /api/tiktok/ops/run                       body {steps?: string[]}
 *   GET  /api/tiktok/ops/comments-feed?since=ISO&cursor=…&limit=…&steamAppId=…
 *        Comment feed for SentimentPulse. Consumers apply tombstones as
 *        exclusions, retaining raw text for audit. No age-based expiry.
 */
import type { Express, Request, Response } from "express";
import { storage } from "./storage";
import { ttDb } from "./tiktok/db";
import { COHORT_WINDOWS, COHORT_SORTS, computeCohortLeaderboard, listTitleVideos, type CohortWindow, type CohortSort } from "./tiktok/cohort";
import { runPipeline, runBackfillStep } from "./tiktok/pipeline";
import { EnsembleDataClient, ensembleTokenFromEnv, EnsembleDataUnitBudgetError } from "./tiktok/api";
import { syncTitles, buildTitleSources, type TitleRow, type SentimentPulseGameLite } from "./tiktok/titles";
import { listSentimentPulseGames, listCompetitorsForParent } from "./sentimentpulse-client";
import { log } from "./log";
import { readCommentFeed } from "./tiktok/feed";
import { readTikTokSeries, SeriesInputError, SeriesNotFoundError } from "./tiktok/series";

export function tiktokEnsembleToken(): string | null {
  const v = storage.getSetting("tiktok_ensemble_token")?.value?.trim();
  return v || ensembleTokenFromEnv();
}

const TITLE_SYNC_TTL_MS = 15 * 60_000;
let lastTitleSync = 0;
let titleSyncInFlight: Promise<{ titles: number; sentimentpulse: boolean }> | null = null;

export async function syncTikTokTitles(force = false): Promise<{ titles: number; sentimentpulse: boolean }> {
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
      log(`tiktok title sync: SentimentPulse unavailable, keeping existing titles (${e})`, "tiktok");
      games = null;
    }
    const n = syncTitles(ttDb(), buildTitleSources(products, games, competitorParent), new Date(), games !== null);
    lastTitleSync = Date.now();
    return { titles: n, sentimentpulse: games !== null };
  })().finally(() => { titleSyncInFlight = null; });
  return titleSyncInFlight;
}

export async function triggerTikTokRun(trigger: string, steps?: any[]) {
  await syncTikTokTitles(true);
  const tok = tiktokEnsembleToken();
  const client = tok ? new EnsembleDataClient({ token: tok }) : null;
  const runRowIns = ttDb().prepare(`INSERT INTO tt_ingest_runs (trigger, started_at, status) VALUES (?, ?, 'running')`).run(trigger, new Date().toISOString());
  const runRow = { id: Number(runRowIns.lastInsertRowid) };
  const res = await runPipeline(ttDb(), client, { extendedStorageApproved: true, steps }, trigger, runRow);
  log(`tiktok run (${trigger}): ${JSON.stringify({ ...res, notes: undefined })}`, "tiktok");
  return res;
}

/** Manual 90-day comment backfill. Scoped to explicit titleIds so you can
 *  run the six Saber parents without touching competitors. */
export async function triggerTikTokBackfill(titleIds: number[], windowDays?: number, unitCap?: number) {
  await syncTikTokTitles(true);
  const tok = tiktokEnsembleToken();
  if (!tok) throw new Error("TikTok EnsembleData token is not configured");
  const client = new EnsembleDataClient({ token: tok });
  const runRowIns = ttDb().prepare(`INSERT INTO tt_ingest_runs (trigger, started_at, status) VALUES ('backfill', ?, 'running')`).run(new Date().toISOString());
  const runRow = { id: Number(runRowIns.lastInsertRowid) };
  const res = await runBackfillStep(ttDb(), client, {
    extendedStorageApproved: true, steps: ["backfill"],
    backfillTitleIds: titleIds, backfillWindowDays: windowDays, backfillUnitCap: unitCap,
  }, "backfill", runRow);
  log(`tiktok backfill: ${JSON.stringify({ ...res, notes: undefined })}`, "tiktok");
  return res;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
}

function tiktokSeriesCsv(data: ReturnType<typeof readTikTokSeries>): string {
  const head = ["date", "publishedVideos", "collectedComments", "snapshotVideos", "snapshotComments",
    "snapshotViews", "matchedVideos", "netViews", "netComments"];
  const lines = [head.join(",")];
  for (const r of data.rows) {
    lines.push([r.date, r.publishedVideos, r.collectedComments, r.snapshotVideos ?? "", r.snapshotComments ?? "",
      r.snapshotViews ?? "", r.matchedVideos ?? "", r.netViews ?? "", r.netComments ?? ""].join(","));
  }
  return lines.join("\n") + "\n";
}

export function registerTikTokRoutes(app: Express) {
  for (const suffix of ["timeseries", "timeseries.csv"]) {
    app.get(`/api/tiktok/titles/:titleId/${suffix}`, (req: Request, res: Response) => {
      try {
        const str = (key: string) => typeof req.query[key] === "string" ? req.query[key] as string : undefined;
        const data = readTikTokSeries(ttDb(), Number(req.params.titleId), {
          start: str("start"), end: str("end"), bucket: str("bucket"),
          includeArchived: req.query.includeArchived === "1",
        });
        if (suffix.endsWith(".csv")) {
          res.setHeader("Content-Disposition", `attachment; filename="tiktok-${data.titleId}-${data.start}-${data.end}-${data.bucket}.csv"`);
          return res.type("text/csv; charset=utf-8").send(tiktokSeriesCsv(data));
        }
        res.json(data);
      } catch (e) {
        res.status(e instanceof SeriesInputError ? 400 : e instanceof SeriesNotFoundError ? 404 : 500)
          .json({ error: (e as Error).message });
      }
    });
  }

  app.get("/api/tiktok/leaderboard", async (req: Request, res: Response) => {
    try {
      await syncTikTokTitles().catch(() => undefined);
      const scope = req.query.scope === "all" ? "all" : "saber";
      const window = pick<CohortWindow>(req.query.window, COHORT_WINDOWS, "d1");
      const sort = pick<CohortSort>(req.query.sort, COHORT_SORTS, "views");
      const direction = req.query.direction === "asc" ? "asc" : "desc";
      const rows = computeCohortLeaderboard(ttDb(), window, sort, direction, new Date(), scope);
      const headers = new Map(storage.getAllProducts().filter((p: any) => p.steamAppId).map((p: any) => [Number(p.steamAppId), p.steamHeaderImageUrl ?? null]));
      const lastRun = ttDb().prepare("SELECT * FROM tt_ingest_runs WHERE status != 'running' ORDER BY id DESC LIMIT 1").get() ?? null;
      res.json({
        definition: "cohort",
        window, sort, direction, scope,
        generatedAt: new Date().toISOString(),
        apiKeyConfigured: !!tiktokEnsembleToken(),
        lastRun,
        rows: rows.map((r) => ({ ...r, headerImageUrl: headers.get(r.titleId) ?? `https://cdn.cloudflare.steamstatic.com/steam/apps/${r.titleId}/header.jpg` })),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/api/tiktok/titles/:titleId/videos", (req: Request, res: Response) => {
    const titleId = Number(req.params.titleId);
    if (!Number.isInteger(titleId) || titleId < 1) return res.status(400).json({ error: "invalid titleId" });
    const window = pick<CohortWindow>(req.query.window, COHORT_WINDOWS, "d1");
    const limit = Math.min(250, Math.max(1, Number(req.query.limit) || 50));
    res.json({ titleId, window, videos: listTitleVideos(ttDb(), titleId, window, limit) });
  });

  app.get("/api/tiktok/status", (_req: Request, res: Response) => {
    const db = ttDb();
    const count = (sql: string) => (db.prepare(sql).get() as any).n as number;
    res.json({
      apiKeyConfigured: !!tiktokEnsembleToken(),
      counts: {
        titles: count("SELECT COUNT(*) n FROM tt_titles WHERE enabled=1"),
        videos: count("SELECT COUNT(*) n FROM tt_videos"),
        comments: count("SELECT COUNT(*) n FROM tt_comments"),
        oldestCommentFetch: (db.prepare("SELECT MIN(fetched_at) m FROM tt_comments").get() as any).m,
      },
      titles: db.prepare(`SELECT t.title_id, t.title, t.hashtags, t.keywords, t.backfill_floor, t.backfill_oldest, t.last_incremental_at,
          (SELECT COUNT(*) FROM tt_videos v WHERE v.title_id=t.title_id) AS videos,
          (SELECT COUNT(*) FROM tt_comments c WHERE c.title_id=t.title_id) AS comments
        FROM tt_titles t WHERE t.enabled=1 ORDER BY t.title`).all(),
      runs: db.prepare("SELECT * FROM tt_ingest_runs ORDER BY id DESC LIMIT 10").all(),
    });
  });

  let runInFlight = false;
  app.post("/api/tiktok/ops/run", (req: Request, res: Response) => {
    if (runInFlight) return res.status(409).json({ error: "a TikTok run is already in progress" });
    const allowed = ["retention", "discovery", "stats", "comments"];
    const steps = Array.isArray(req.body?.steps) ? req.body.steps.filter((s: any) => allowed.includes(s)) : undefined;
    runInFlight = true;
    triggerTikTokRun("manual", steps)
      .catch((e) => log(`tiktok manual run failed: ${e}`, "tiktok"))
      .finally(() => { runInFlight = false; });
    res.status(202).json({ accepted: true, steps: steps ?? allowed });
  });

  let backfillInFlight = false;
  app.post("/api/tiktok/ops/backfill", (req: Request, res: Response) => {
    if (backfillInFlight) return res.status(409).json({ error: "a TikTok backfill is already in progress" });
    if (runInFlight) return res.status(409).json({ error: "a TikTok run is already in progress" });
    const titleIds = Array.isArray(req.body?.titleIds) ? req.body.titleIds.map(Number).filter(Number.isFinite) : [];
    if (!titleIds.length) return res.status(400).json({ error: "titleIds must be a non-empty array of title IDs (Steam App IDs)" });
    const windowDays = typeof req.body?.windowDays === "number" && req.body.windowDays > 0 ? req.body.windowDays : 90;
    const unitCap = typeof req.body?.unitCap === "number" && req.body.unitCap > 0 ? req.body.unitCap : 3500;
    backfillInFlight = true;
    triggerTikTokBackfill(titleIds, windowDays, unitCap)
      .catch((e) => log(`tiktok backfill failed: ${e}`, "tiktok"))
      .finally(() => { backfillInFlight = false; });
    res.status(202).json({ accepted: true, titleIds, windowDays, unitCap });
  });

  app.get("/api/tiktok/ops/comments-feed", (req: Request, res: Response) => {
    const str = (key: string) => typeof req.query[key] === "string" ? req.query[key] as string : undefined;
    try {
      res.json({
        ...readCommentFeed(ttDb(), {
          since: str("since"), until: str("until"), cursor: str("cursor"),
          deletedSince: str("deletedSince"), steamAppId: str("steamAppId"), limit: Number(req.query.limit),
        }),
        retention: { mode: "unlimited", maxTextAgeDays: null },
      });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
}
