/**
 * Express routes for Promo Calendar. All routes mounted under /api by the
 * caller (index.ts). In production, nginx proxies /promo/api/* → this port
 * with the /promo prefix stripped.
 */
import express, { type Express, type Request, type Response } from "express";
import multer from "multer";
import { parsePromoWorkbook } from "./parser.js";
import {
  distinctPlatforms,
  distinctPrograms,
  getActiveUpload,
  getCampaign,
  getEvent,
  getUploadBlob,
  ingest,
  isCalendarId,
  listCampaigns,
  listEvents,
  listGames,
  listUploads,
  liveNowForCalendar,
  liveNowForGame,
  nextUpForCalendar,
  nextUpForGame,
  nextUpForPlatform,
  nextUpMultiTitle,
  rollbackTo,
  serverToday,
} from "./storage.js";
import { CALENDARS, CALENDAR_LABELS, type CalendarId } from "../shared/schema.js";
import { callerEmail, isUploaderReq, requireUploader } from "./auth.js";
import { steamAppIdForCode } from "./signalpulse-map.js";
import { getSteamRevenueForWindow } from "./signalpulse-client.js";
import { syncSteamPlsEvents } from "./sync-pls-events.js";

// Excel files can be big. 20 MB ceiling.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function requireCalendar(req: Request, res: Response): CalendarId | null {
  const cal = req.params.calendar;
  if (!isCalendarId(cal)) {
    res.status(404).json({ error: "unknown calendar", value: cal });
    return null;
  }
  return cal;
}

export function registerRoutes(app: Express): void {
  app.use(express.json({ limit: "5mb" }));

  // ─── Meta / health ────────────────────────────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "promocalendar" });
  });

  // Tell the frontend whether the current caller can upload / roll back.
  // Used to hide/show the Settings > Upload button.
  app.get("/api/me", (req, res) => {
    res.json({
      email: callerEmail(req),
      can_upload: isUploaderReq(req),
    });
  });

  app.get("/api/calendars", (_req, res) => {
    res.json({
      calendars: CALENDARS.map((id) => ({
        id,
        label: CALENDAR_LABELS[id],
        active_upload: getActiveUpload(id),
      })),
    });
  });

  // ─── Ingest ───────────────────────────────────────────────────────────────
  app.post(
    "/api/:calendar/upload",
    requireUploader,
    upload.single("file"),
    async (req, res) => {
      const cal = requireCalendar(req, res);
      if (!cal) return;
      const f = (req as any).file as Express.Multer.File | undefined;
      if (!f) {
        return res.status(400).json({ error: "missing file field 'file'" });
      }
      if (!f.originalname.toLowerCase().endsWith(".xlsx")) {
        return res.status(400).json({
          error: "file must be an .xlsx workbook",
          got: f.originalname,
        });
      }
      const uploadedBy = (req.body?.uploaded_by || null) as string | null;

      try {
        const parseResult = await parsePromoWorkbook(f.buffer);
        if (parseResult.campaigns.length === 0) {
          return res.status(422).json({
            error: "no campaigns parsed from the workbook",
            warnings: parseResult.warnings,
            sheets_processed: parseResult.sheets_processed,
            sheets_skipped: parseResult.sheets_skipped,
          });
        }
        const { upload: uploadRow } = ingest(
          cal,
          { filename: f.originalname, buffer: f.buffer },
          uploadedBy,
          parseResult,
        );

        // Sync every Steam campaign in the new active upload to SignalPulse
        // PLS milestones (category='promotion'). Runs synchronously so the
        // upload response body shows exactly what happened. Never throws —
        // errors are surfaced in `pls_sync.warnings` and the upload still
        // returns 201.
        const plsSync = await syncSteamPlsEvents(cal);

        res.status(201).json({
          upload: uploadRow,
          parse: {
            campaigns: parseResult.campaigns.length,
            skus: parseResult.campaigns.reduce((s, c) => s + c.skus.length, 0),
            warnings: parseResult.warnings,
            sheets_processed: parseResult.sheets_processed,
            sheets_skipped: parseResult.sheets_skipped,
          },
          pls_sync: plsSync,
        });
      } catch (e: any) {
        console.error("ingest failed:", e);
        res.status(500).json({ error: "ingest failed", message: e?.message ?? String(e) });
      }
    },
  );

  // ─── Uploads history + rollback ──────────────────────────────────────────
  app.get("/api/:calendar/uploads", (req, res) => {
    const cal = requireCalendar(req, res);
    if (!cal) return;
    res.json({ uploads: listUploads(cal) });
  });

  app.get("/api/uploads/:id/download", (req, res) => {
    const id = Number(req.params.id);
    const stored = getUploadBlob(id);
    if (!stored) return res.status(404).json({ error: "upload not found" });
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${stored.filename.replace(/"/g, "")}"`,
    );
    res.send(stored.blob);
  });

  app.post("/api/uploads/:id/rollback", requireUploader, async (req, res) => {
    const id = Number(req.params.id);
    try {
      const activated = await rollbackTo(id, parsePromoWorkbook);
      if (!activated) return res.status(404).json({ error: "upload not found" });
      res.json({ activated });
    } catch (e: any) {
      console.error("rollback failed:", e);
      res.status(500).json({ error: "rollback failed", message: e?.message ?? String(e) });
    }
  });

  // ─── Campaigns / calendar reads ──────────────────────────────────────────
  app.get("/api/:calendar/campaigns", (req, res) => {
    const cal = requireCalendar(req, res);
    if (!cal) return;
    const rows = listCampaigns(cal, {
      platform: (req.query.platform as string) || undefined,
      game_code: (req.query.game_code as string) || undefined,
      program: (req.query.program as string) || undefined,
      from: (req.query.from as string) || undefined,
      to: (req.query.to as string) || undefined,
    });
    res.json({ campaigns: rows, count: rows.length });
  });

  app.get("/api/campaigns/:id", (req, res) => {
    const id = Number(req.params.id);
    const out = getCampaign(id);
    if (!out) return res.status(404).json({ error: "campaign not found" });
    res.json(out);
  });

  app.get("/api/:calendar/games", (req, res) => {
    const cal = requireCalendar(req, res);
    if (!cal) return;
    res.json({ games: listGames(cal) });
  });

  app.get("/api/:calendar/filters", (req, res) => {
    const cal = requireCalendar(req, res);
    if (!cal) return;
    res.json({
      platforms: distinctPlatforms(cal),
      programs: distinctPrograms(cal),
    });
  });

  // ─── Next Up ─────────────────────────────────────────────────────────────
  // All in-flight campaigns (start <= today <= end). Steam-biased, then
  // soonest-ending first. Same shape as /next-up plus optional Steam
  // revenue enrichment for Steam beats — sums net/gross USD from beat
  // start_date through today via SignalPulse's steam-revenue endpoint.
  //
  // Never fails the request on SignalPulse errors: on failure the extra
  // fields are simply omitted so the client falls back to "—".
  app.get("/api/:calendar/live-now", async (req, res) => {
    const cal = requireCalendar(req, res);
    if (!cal) return;
    const today = serverToday((req.query.today as string) || null);
    const beats = liveNowForCalendar(cal, today);

    // Enrich Steam beats in parallel (bounded by number of concurrent live
    // beats — realistically <20; signalpulse-client also caches 60s so a
    // rapid page refresh doesn't hammer the backend).
    const enriched = await Promise.all(
      beats.map(async (b) => {
        if (b.platform !== "Steam") return b;
        const appid = steamAppIdForCode(b.game_code);
        if (!appid) return b;
        try {
          const rev = await getSteamRevenueForWindow(
            appid,
            b.start_date,
            today,
          );
          if (!rev) return b;
          return {
            ...b,
            steam_current_net_revenue_usd: rev.net_revenue_usd,
            steam_current_gross_revenue_usd: rev.gross_revenue_usd,
            steam_current_days_covered: rev.days_covered,
          };
        } catch {
          // Belt-and-suspenders: signalpulse-client already swallows
          // errors, but be defensive here so one bad response never
          // takes down the /live-now response.
          return b;
        }
      }),
    );

    res.json({
      calendar: cal,
      today,
      beats: enriched,
    });
  });

  // All three variants take `?limit=N&today=YYYY-MM-DD`.
  // `today` is a testing/demo override; defaults to server date.
  app.get("/api/:calendar/next-up", (req, res) => {
    const cal = requireCalendar(req, res);
    if (!cal) return;
    const today = serverToday((req.query.today as string) || null);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 3));
    res.json({
      calendar: cal,
      today,
      beats: nextUpForCalendar(cal, limit, today),
    });
  });

  app.get("/api/:calendar/platforms/:platform/next-up", (req, res) => {
    const cal = requireCalendar(req, res);
    if (!cal) return;
    const platform = req.params.platform;
    const today = serverToday((req.query.today as string) || null);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 3));
    res.json({
      calendar: cal,
      platform,
      today,
      beats: nextUpForPlatform(cal, platform, limit, today),
    });
  });

  app.get("/api/:calendar/games/:game_code/next-up", (req, res) => {
    const cal = requireCalendar(req, res);
    if (!cal) return;
    const game_code = req.params.game_code;
    const today = serverToday((req.query.today as string) || null);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 3));
    res.json({
      calendar: cal,
      game_code,
      today,
      beats: nextUpForGame(cal, game_code, limit, today),
    });
  });

  // PDP-scoped Live Now. Same Steam-revenue enrichment behavior as
  // /api/:calendar/live-now above — Steam beats get
  // steam_current_{net,gross}_revenue_usd + steam_current_days_covered
  // via SignalPulse's /api/promo-support/steam-revenue endpoint. Errors
  // fall through: extra fields omitted, chip degrades to "—".
  // Added 2026-09-04 alongside the strict-future PDP Next Up fix.
  app.get("/api/:calendar/games/:game_code/live-now", async (req, res) => {
    const cal = requireCalendar(req, res);
    if (!cal) return;
    const game_code = req.params.game_code;
    const today = serverToday((req.query.today as string) || null);
    const beats = liveNowForGame(cal, game_code, today);

    const enriched = await Promise.all(
      beats.map(async (b) => {
        if (b.platform !== "Steam") return b;
        const appid = steamAppIdForCode(b.game_code);
        if (!appid) return b;
        try {
          const rev = await getSteamRevenueForWindow(
            appid,
            b.start_date,
            today,
          );
          if (!rev) return b;
          return {
            ...b,
            steam_current_net_revenue_usd: rev.net_revenue_usd,
            steam_current_gross_revenue_usd: rev.gross_revenue_usd,
            steam_current_days_covered: rev.days_covered,
          };
        } catch {
          return b;
        }
      }),
    );

    res.json({
      calendar: cal,
      game_code,
      today,
      beats: enriched,
    });
  });

  // ─── Next Up: Multi-Title Promos ─────────────────────────────────────────
  // Groups beats by (program, platform, start, end) that span 2+ titles.
  // Powers the "Next Up Multi-Title Promo" strip on the calendar landing page
  // AND on per-platform views (via ?platform=…). Top-3 default.
  app.get("/api/:calendar/next-up/multi-title", (req, res) => {
    const cal = requireCalendar(req, res);
    if (!cal) return;
    const today = serverToday((req.query.today as string) || null);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 3));
    const platform = (req.query.platform as string) || undefined;
    const minTitles = Number(req.query.min_titles) || 2;
    res.json({
      calendar: cal,
      today,
      platform: platform ?? null,
      min_titles: minTitles,
      beats: nextUpMultiTitle(cal, limit, today, { platform, minTitles }),
    });
  });

  app.get("/api/:calendar/platforms/:platform/next-up/multi-title", (req, res) => {
    const cal = requireCalendar(req, res);
    if (!cal) return;
    const platform = req.params.platform;
    const today = serverToday((req.query.today as string) || null);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 3));
    const minTitles = Number(req.query.min_titles) || 2;
    res.json({
      calendar: cal,
      platform,
      today,
      min_titles: minTitles,
      beats: nextUpMultiTitle(cal, limit, today, { platform, minTitles }),
    });
  });

  // ─── Events tab (browse all multi-title events) ────────────────────────
  // Every multi-title promo as a first-class object.
  // ?when=upcoming|live|past|all (default: all)
  // ?platform=Steam|Microsoft|Sony|… optional filter
  // ?program=... optional exact-match filter
  // ?min_titles=N (default 2)
  // ?from=YYYY-MM-DD, ?to=YYYY-MM-DD optional overlap window
  // ?today=YYYY-MM-DD demo/testing override
  app.get("/api/:calendar/events", (req, res) => {
    const cal = requireCalendar(req, res);
    if (!cal) return;
    const today = serverToday((req.query.today as string) || null);
    const whenRaw = (req.query.when as string) || "all";
    const when = (["upcoming", "live", "past", "all"] as const).includes(
      whenRaw as any,
    )
      ? (whenRaw as "upcoming" | "live" | "past" | "all")
      : "all";
    const events = listEvents(cal, today, {
      platform: (req.query.platform as string) || undefined,
      program: (req.query.program as string) || undefined,
      when,
      min_titles: Number(req.query.min_titles) || 2,
      from: (req.query.from as string) || undefined,
      to: (req.query.to as string) || undefined,
    });
    res.json({
      calendar: cal,
      today,
      when,
      count: events.length,
      events,
    });
  });

  app.get("/api/:calendar/events/:event_key", (req, res) => {
    const cal = requireCalendar(req, res);
    if (!cal) return;
    const today = serverToday((req.query.today as string) || null);
    const detail = getEvent(cal, req.params.event_key, today);
    if (!detail) return res.status(404).json({ error: "event not found" });
    res.json({ calendar: cal, today, event: detail });
  });
}
