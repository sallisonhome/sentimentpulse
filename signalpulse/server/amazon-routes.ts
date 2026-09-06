/**
 * Amazon Retail — HTTP endpoints.
 *
 * All routes are prefixed `/api/amazon` and mounted from `routes.ts` via
 * `registerAmazonRoutes(app)`. The saber-auth middleware is already applied
 * globally in `server/index.ts`, so mutating endpoints inherit it.
 *
 * Endpoint families:
 *   /leaderboard/saber        — third tab on the leaderboards page
 *   /charts/:platform         — full top-50 per platform, with deltas
 *   /product/:asin, /also-bought — per-title drill-down
 *   /buybox, /reviews-pulse, /movers, /search-sov, /new-releases
 *                             — sub-app data endpoints
 *   /asin-map (GET/POST/DELETE) — pinned SignalPulse-product ↔ ASIN mapping
 *   /ingest/run/:job, /ingest/runs — manual run + recent run log
 */
import type { Express, Request, Response } from "express";
import { db, storage } from "./storage";
import {
  amazonAsinMap,
  amazonChartSnapshots,
  amazonProductDaily,
  amazonAlsoBoughtDaily,
  amazonMoversDaily,
  amazonNewReleases,
  amazonKeywordDaily,
  amazonIngestRuns,
  AMAZON_PLATFORM_SLUGS,
  AMAZON_CHART_NODES,
  type AmazonPlatformSlug,
} from "@shared/schema";
import { and, desc, eq } from "drizzle-orm";
import { runAmazonJob, type AmazonJobName } from "./amazon-cron";
import { isRainforestConfigured } from "./amazon-rainforest";

// ─── Small helpers ──────────────────────────────────────────────────────────
function daysAgoUtcDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split("T")[0];
}

function isPlatformSlug(v: string): v is AmazonPlatformSlug {
  return (AMAZON_PLATFORM_SLUGS as readonly string[]).includes(v);
}

// Given today's ranked rows for a platform, find (rank now - rank Xd ago).
// Positive means the title moved UP (lower number = better). Null when
// the ASIN wasn't on the chart on the comparison date.
function rankDelta(
  todayRank: number,
  historicRow: { rank: number } | undefined,
): number | null {
  if (!historicRow) return null;
  return historicRow.rank - todayRank; // improved → positive
}

// ─── Registration ──────────────────────────────────────────────────────────
export function registerAmazonRoutes(app: Express): void {
  // ── Configuration status ───────────────────────────────────────────────
  app.get("/api/amazon/status", (_req, res) => {
    res.json({
      configured: isRainforestConfigured(),
      platforms: AMAZON_PLATFORM_SLUGS,
      chartNodes: AMAZON_CHART_NODES,
    });
  });

  // ── Saber Amazon Leaderboard (feeds the third tab on /leaderboards) ────
  app.get("/api/amazon/leaderboard/saber", (_req, res) => {
    try {
      const today = daysAgoUtcDate(0);

      // All active pinned ASINs, joined with product titles.
      const pins = db.select().from(amazonAsinMap)
        .where(eq(amazonAsinMap.isActive, true)).all();
      const productsList = storage.getAllProducts();
      const productsById = new Map(productsList.map((p) => [p.id, p]));

      // Group pins by productId to build a per-title map of platform ranks.
      type PinLite = { platform: string; asin: string; isSwitch2: boolean };
      const byProduct = new Map<number, PinLite[]>();
      for (const pin of pins) {
        if (!byProduct.has(pin.productId)) byProduct.set(pin.productId, []);
        byProduct.get(pin.productId)!.push({
          platform: pin.platform,
          asin: pin.asin,
          isSwitch2: pin.isSwitch2,
        });
      }

      // For each ASIN, look up rank today / 1d / 7d / 30d ago from
      // amazonChartSnapshots. Everything gracefully degrades to null.
      const lookupAsinRankOn = (asin: string, platform: string, date: string) => {
        const row = db.select().from(amazonChartSnapshots)
          .where(and(
            eq(amazonChartSnapshots.snapshotDate, date),
            eq(amazonChartSnapshots.platform, platform),
            eq(amazonChartSnapshots.asin, asin),
          )).get();
        return row ?? null;
      };

      const saberTitles: unknown[] = [];
      byProduct.forEach((productPins, productId) => {
        const p = productsById.get(productId);
        if (!p) return;
        const platformsPayload: Record<string, unknown> = {};
        for (const slug of AMAZON_PLATFORM_SLUGS) {
          const pin = productPins.find((x: PinLite) => x.platform === slug);
          if (!pin) { platformsPayload[slug] = null; continue; }
          const rowToday = lookupAsinRankOn(pin.asin, slug, today);
          if (!rowToday) { platformsPayload[slug] = null; continue; }
          const row1d  = lookupAsinRankOn(pin.asin, slug, daysAgoUtcDate(1));
          const row7d  = lookupAsinRankOn(pin.asin, slug, daysAgoUtcDate(7));
          const row30d = lookupAsinRankOn(pin.asin, slug, daysAgoUtcDate(30));
          platformsPayload[slug] = {
            rank: rowToday.rank,
            rawRank: rowToday.rawRank,
            price: rowToday.price,
            rating: rowToday.rating,
            delta1d:  rankDelta(rowToday.rank, row1d ? { rank: row1d.rank } : undefined),
            delta7d:  rankDelta(rowToday.rank, row7d ? { rank: row7d.rank } : undefined),
            delta30d: rankDelta(rowToday.rank, row30d ? { rank: row30d.rank } : undefined),
            asin: pin.asin,
            isSwitch2: pin.isSwitch2,
          };
        }
        saberTitles.push({
          productId,
          title: p.title,
          platforms: platformsPayload,
        });
      });

      // No competitor-specific persistence yet — future work; return empty
      // list so the UI can render its section unconditionally.
      res.json({ saberTitles, competitorTitles: [] });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // ── Full top-50 per platform ───────────────────────────────────────────
  app.get("/api/amazon/charts/:platform", (req, res) => {
    const platform = req.params.platform;
    if (!isPlatformSlug(platform)) return res.status(400).json({ error: "invalid platform" });
    const limitParam = parseInt((req.query.limit as string) ?? "50", 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 50;

    // Latest snapshot date for this platform (may be < today if the cron
    // hasn't run yet; UI shows the header date so this is not confusing).
    const latest = db.select().from(amazonChartSnapshots)
      .where(eq(amazonChartSnapshots.platform, platform))
      .orderBy(desc(amazonChartSnapshots.snapshotDate))
      .limit(1).get();
    if (!latest) return res.json({ snapshotDate: null, platform, rows: [] });

    const snapshotDate = latest.snapshotDate;
    const rows = db.select().from(amazonChartSnapshots)
      .where(and(
        eq(amazonChartSnapshots.snapshotDate, snapshotDate),
        eq(amazonChartSnapshots.platform, platform),
      ))
      .orderBy(amazonChartSnapshots.rank)
      .all()
      .slice(0, limit);

    // Delta lookups
    const d1  = daysAgoUtcDate(1);
    const d7  = daysAgoUtcDate(7);
    const d30 = daysAgoUtcDate(30);

    function findRankOn(date: string, asin: string): number | null {
      const r = db.select().from(amazonChartSnapshots)
        .where(and(
          eq(amazonChartSnapshots.snapshotDate, date),
          eq(amazonChartSnapshots.platform, platform),
          eq(amazonChartSnapshots.asin, asin),
        )).get();
      return r?.rank ?? null;
    }

    // Tracked map for chip
    const trackedMap = new Map(
      db.select().from(amazonAsinMap)
        .where(and(eq(amazonAsinMap.platform, platform), eq(amazonAsinMap.isActive, true)))
        .all()
        .map((r) => [r.asin, r.productId]),
    );

    const enriched = rows.map((r) => {
      const rank1  = findRankOn(d1,  r.asin);
      const rank7  = findRankOn(d7,  r.asin);
      const rank30 = findRankOn(d30, r.asin);
      return {
        rank: r.rank,
        rawRank: r.rawRank,
        asin: r.asin,
        title: r.title,
        price: r.price,
        rating: r.rating,
        ratingsTotal: r.ratingsTotal,
        imageUrl: r.imageUrl,
        link: r.link,
        delta1d:  rank1  != null ? rank1  - r.rank : null,
        delta7d:  rank7  != null ? rank7  - r.rank : null,
        delta30d: rank30 != null ? rank30 - r.rank : null,
        isTracked: trackedMap.has(r.asin),
        trackedProductId: trackedMap.get(r.asin) ?? null,
      };
    });

    res.json({ snapshotDate, platform, rows: enriched });
  });

  // 30-day rank history for one ASIN on one platform
  app.get("/api/amazon/charts/:platform/history/:asin", (req, res) => {
    const platform = req.params.platform;
    if (!isPlatformSlug(platform)) return res.status(400).json({ error: "invalid platform" });
    const asin = req.params.asin;
    const rows = db.select().from(amazonChartSnapshots)
      .where(and(
        eq(amazonChartSnapshots.platform, platform),
        eq(amazonChartSnapshots.asin, asin),
      ))
      .orderBy(desc(amazonChartSnapshots.snapshotDate))
      .limit(30).all();
    const points = rows.map((r) => ({ date: r.snapshotDate, rank: r.rank, rawRank: r.rawRank })).reverse();
    res.json({ platform, asin, points });
  });

  // ── Per-title drill-down ───────────────────────────────────────────────
  app.get("/api/amazon/product/:asin", (req, res) => {
    const asin = req.params.asin;

    // Latest product-daily row
    const latestProduct = db.select().from(amazonProductDaily)
      .where(eq(amazonProductDaily.asin, asin))
      .orderBy(desc(amazonProductDaily.snapshotDate))
      .limit(1).get();

    // Pinned metadata (may be undefined for a "recommended" ASIN not in our map)
    const pin = db.select().from(amazonAsinMap)
      .where(eq(amazonAsinMap.asin, asin))
      .get();
    const product = pin ? storage.getAllProducts().find((p) => p.id === pin.productId) ?? null : null;

    // Today's chart position across all platforms this ASIN appears on
    const today = daysAgoUtcDate(0);
    const chartToday: Record<string, unknown> = {};
    for (const slug of AMAZON_PLATFORM_SLUGS) {
      const row = db.select().from(amazonChartSnapshots)
        .where(and(
          eq(amazonChartSnapshots.snapshotDate, today),
          eq(amazonChartSnapshots.platform, slug),
          eq(amazonChartSnapshots.asin, asin),
        )).get();
      chartToday[slug] = row ? { rank: row.rank, rawRank: row.rawRank, title: row.title } : null;
    }

    // 30-day rank sparkline: pick the platform where this ASIN has the most
    // recent activity (first hit).
    let sparkline: { date: string; rank: number }[] = [];
    let sparklinePlatform: string | null = null;
    for (const slug of AMAZON_PLATFORM_SLUGS) {
      const rows = db.select().from(amazonChartSnapshots)
        .where(and(
          eq(amazonChartSnapshots.platform, slug),
          eq(amazonChartSnapshots.asin, asin),
        ))
        .orderBy(desc(amazonChartSnapshots.snapshotDate))
        .limit(30).all();
      if (rows.length > 0) {
        sparkline = rows.map((r) => ({ date: r.snapshotDate, rank: r.rank })).reverse();
        sparklinePlatform = slug;
        break;
      }
    }

    res.json({
      asin,
      product,
      pin: pin ?? null,
      latestProduct: latestProduct ?? null,
      chartToday,
      sparkline,
      sparklinePlatform,
    });
  });

  app.get("/api/amazon/product/:asin/also-bought", (req, res) => {
    const asin = req.params.asin;
    // Most recent snapshot date that has any rows for this source ASIN.
    const latest = db.select().from(amazonAlsoBoughtDaily)
      .where(eq(amazonAlsoBoughtDaily.sourceAsin, asin))
      .orderBy(desc(amazonAlsoBoughtDaily.snapshotDate))
      .limit(1).get();
    if (!latest) return res.json({ asin, snapshotDate: null, recommendations: [] });
    const rows = db.select().from(amazonAlsoBoughtDaily)
      .where(and(
        eq(amazonAlsoBoughtDaily.sourceAsin, asin),
        eq(amazonAlsoBoughtDaily.snapshotDate, latest.snapshotDate),
      ))
      .orderBy(amazonAlsoBoughtDaily.rankPosition)
      .all();
    res.json({
      asin,
      snapshotDate: latest.snapshotDate,
      recommendations: rows.map((r) => ({
        rankPosition: r.rankPosition,
        recommendedAsin: r.recommendedAsin,
        title: r.title,
        price: r.price,
        rating: r.rating,
        ratingsTotal: r.ratingsTotal,
        mainBsr: r.mainBsr,
        imageUrl: r.imageUrl,
        link: r.link,
      })),
    });
  });

  // ── Sub-app endpoints ──────────────────────────────────────────────────
  app.get("/api/amazon/buybox", (_req, res) => {
    // Grid: every tracked ASIN's latest amazon_product_daily row + pin meta
    const pins = db.select().from(amazonAsinMap)
      .where(eq(amazonAsinMap.isActive, true)).all();
    const productsById = new Map(storage.getAllProducts().map((p) => [p.id, p]));
    const rows = pins.map((pin) => {
      const latest = db.select().from(amazonProductDaily)
        .where(eq(amazonProductDaily.asin, pin.asin))
        .orderBy(desc(amazonProductDaily.snapshotDate))
        .limit(1).get();
      return {
        productId: pin.productId,
        title: productsById.get(pin.productId)?.title ?? null,
        platform: pin.platform,
        asin: pin.asin,
        isSwitch2: pin.isSwitch2,
        snapshotDate: latest?.snapshotDate ?? null,
        buyboxPrice: latest?.buyboxPrice ?? null,
        buyboxSeller: latest?.buyboxSeller ?? null,
        buyboxIsAmazon: latest?.buyboxIsAmazon ?? null,
        isPrime: latest?.isPrime ?? null,
        stockStatus: latest?.stockStatus ?? null,
        mainBsr: latest?.mainBsr ?? null,
      };
    });
    res.json({ rows });
  });

  app.get("/api/amazon/reviews-pulse", (_req, res) => {
    // For each tracked ASIN: latest ratingsTotal + delta 7d/30d
    const pins = db.select().from(amazonAsinMap)
      .where(eq(amazonAsinMap.isActive, true)).all();
    const productsById = new Map(storage.getAllProducts().map((p) => [p.id, p]));
    const rows = pins.map((pin) => {
      const latest = db.select().from(amazonProductDaily)
        .where(eq(amazonProductDaily.asin, pin.asin))
        .orderBy(desc(amazonProductDaily.snapshotDate))
        .limit(1).get();
      function findOn(date: string) {
        return db.select().from(amazonProductDaily)
          .where(and(eq(amazonProductDaily.asin, pin.asin), eq(amazonProductDaily.snapshotDate, date)))
          .get();
      }
      const r7  = findOn(daysAgoUtcDate(7));
      const r30 = findOn(daysAgoUtcDate(30));
      const totalNow = latest?.ratingsTotal ?? null;
      return {
        productId: pin.productId,
        title: productsById.get(pin.productId)?.title ?? null,
        asin: pin.asin,
        platform: pin.platform,
        ratingsTotal: totalNow,
        ratingsDelta7d:  totalNow != null && r7?.ratingsTotal  != null ? totalNow - r7.ratingsTotal  : null,
        ratingsDelta30d: totalNow != null && r30?.ratingsTotal != null ? totalNow - r30.ratingsTotal : null,
        rating: latest?.rating ?? null,
      };
    });
    res.json({ rows });
  });

  app.get("/api/amazon/movers/:platform", (req, res) => {
    const platform = req.params.platform;
    if (!isPlatformSlug(platform)) return res.status(400).json({ error: "invalid platform" });
    const latest = db.select().from(amazonMoversDaily)
      .where(eq(amazonMoversDaily.platform, platform))
      .orderBy(desc(amazonMoversDaily.snapshotDate))
      .limit(1).get();
    if (!latest) return res.json({ snapshotDate: null, platform, rows: [] });
    const rows = db.select().from(amazonMoversDaily)
      .where(and(
        eq(amazonMoversDaily.snapshotDate, latest.snapshotDate),
        eq(amazonMoversDaily.platform, platform),
      ))
      .orderBy(amazonMoversDaily.rank)
      .all();
    res.json({ snapshotDate: latest.snapshotDate, platform, rows });
  });

  app.get("/api/amazon/search-sov", (_req, res) => {
    // Latest snapshot per keyword
    const rows = db.select().from(amazonKeywordDaily)
      .orderBy(desc(amazonKeywordDaily.snapshotDate))
      .all();
    const byKeyword = new Map<string, typeof rows[number]>();
    for (const r of rows) {
      if (!byKeyword.has(r.keyword)) byKeyword.set(r.keyword, r);
    }
    const payload = Array.from(byKeyword.values()).map((r) => ({
      keyword: r.keyword,
      snapshotDate: r.snapshotDate,
      results: safeJson(r.resultsJson),
    }));
    res.json({ rows: payload });
  });

  app.get("/api/amazon/new-releases/:platform", (req, res) => {
    const platform = req.params.platform;
    if (!isPlatformSlug(platform)) return res.status(400).json({ error: "invalid platform" });
    const latest = db.select().from(amazonNewReleases)
      .where(eq(amazonNewReleases.platform, platform))
      .orderBy(desc(amazonNewReleases.snapshotDate))
      .limit(1).get();
    if (!latest) return res.json({ snapshotDate: null, platform, rows: [] });
    const rows = db.select().from(amazonNewReleases)
      .where(and(
        eq(amazonNewReleases.snapshotDate, latest.snapshotDate),
        eq(amazonNewReleases.platform, platform),
      ))
      .orderBy(amazonNewReleases.rank)
      .all();
    res.json({ snapshotDate: latest.snapshotDate, platform, rows });
  });

  // ── ASIN Map management ────────────────────────────────────────────────
  app.get("/api/amazon/asin-map", (_req, res) => {
    const rows = db.select().from(amazonAsinMap).all();
    res.json({ rows });
  });

  app.post("/api/amazon/asin-map", (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const productId = Number(body.productId);
      const platform = String(body.platform ?? "");
      const asin = String(body.asin ?? "").trim();
      if (!Number.isFinite(productId) || productId <= 0) return res.status(400).json({ error: "productId required" });
      if (!isPlatformSlug(platform)) return res.status(400).json({ error: "invalid platform" });
      if (!asin) return res.status(400).json({ error: "asin required" });
      const isAuto = body.isAuto == null ? false : !!body.isAuto;
      const isActive = body.isActive == null ? true : !!body.isActive;
      const isSwitch2 = !!body.isSwitch2;
      const now = new Date().toISOString();

      const existing = db.select().from(amazonAsinMap)
        .where(and(eq(amazonAsinMap.productId, productId), eq(amazonAsinMap.platform, platform)))
        .get();
      if (existing) {
        db.update(amazonAsinMap).set({
          asin, isAuto, isActive, isSwitch2, updatedAt: now,
        }).where(eq(amazonAsinMap.id, existing.id)).run();
      } else {
        db.insert(amazonAsinMap).values({
          productId, platform, asin, isAuto, isActive, isSwitch2,
          matchScore: null,
          discoveredAt: isAuto ? now : null,
          updatedAt: now,
        }).run();
      }
      const row = db.select().from(amazonAsinMap)
        .where(and(eq(amazonAsinMap.productId, productId), eq(amazonAsinMap.platform, platform)))
        .get();
      res.json({ row });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  app.delete("/api/amazon/asin-map/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    db.delete(amazonAsinMap).where(eq(amazonAsinMap.id, id)).run();
    res.json({ ok: true });
  });

  // ── Ops: manual ingest + recent runs ───────────────────────────────────
  app.post("/api/amazon/ingest/run/:job", async (req, res) => {
    const job = req.params.job as AmazonJobName;
    if (!["charts", "products", "movers", "keywords", "new_releases", "also_bought"].includes(job)) {
      return res.status(400).json({ error: "unknown job" });
    }
    if (!isRainforestConfigured()) {
      return res.status(400).json({ error: "rainforest_api_key not set" });
    }
    try {
      const result = await runAmazonJob(job);
      res.json({ ok: true, job, result });
    } catch (err: any) {
      res.status(500).json({ ok: false, job, error: err?.message ?? String(err) });
    }
  });

  app.get("/api/amazon/ingest/runs", (_req, res) => {
    const rows = db.select().from(amazonIngestRuns)
      .orderBy(desc(amazonIngestRuns.startedAt))
      .limit(50).all();
    res.json({ rows });
  });
}

function safeJson(s: string | null | undefined): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
