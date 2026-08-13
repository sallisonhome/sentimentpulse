import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage, type SteamWishlistSummary } from "./storage";
import { autoGenerateForecasts, calculateDynamicForecasts, calculateDynamicForecastsFull, getAdjustedPlatformMix, STEAM_WISHLIST_FIRST_MONTH_MULTIPLIER } from "./forecast";
import { generateDefaultMilestones } from "./pls-generator";
import { seedDatabase } from "./seed";
import { extractVideoId, fetchVideoData } from "./youtube-fetcher";
import {
  runIngestion,
  fetchSteamWishlistReportingDay,
  persistSteamWishlistReportingDay,
  getYesterdayGmtDateString,
  runSalesIngestionNow,
  runPublicWishlistIngestionNow,
  runPartnerWishlistIngestionNow,
} from "./ingestion";
import {
  getWishlistLeaderboardRows,
  getWishlistLeaderboardKpis,
  getRevenueLeaderboardRows,
  getRevenueLeaderboardKpis,
} from "./leaderboards";
import { sendWeeklyLeaderboardDigest } from "./leaderboard-digest";

/**
 * Returns the wishlist count that should feed dynamic forecasts.
 *
 * Rule: dynamic forecasts are calculated only from PRE-RELEASE wishlist
 * counts. Once a title has released, this returns the locked pre-release
 * net count (never changes). Before release it returns the current lifetime
 * count (which equals pre-release by definition when releaseDate is future).
 *
 * Falls back to null when there's no wishlist data at all.
 */
function getForecastingWishlistCount(
  summary: SteamWishlistSummary,
  releaseDate: string | null,
): number | null {
  if (summary.lifetimeNet == null) return null;

  const today = new Date().toISOString().split("T")[0];
  const hasReleased = releaseDate != null && releaseDate <= today;

  if (hasReleased) {
    // Post-release: locked to pre-release net. Never changes.
    return summary.preLaunchNet;
  }
  // Pre-release: current lifetime (== pre-release count by construction).
  return summary.lifetimeNet;
}

/**
 * First-month sales forecast for Steam titles using the pre-release-locked WL rule.
 *
 * Rule (locked 2026-08-11): once a title has a Release milestone with an
 * actualDate in the past, the forecast is LOCKED to
 * (preLaunchNet * STEAM_WISHLIST_FIRST_MONTH_MULTIPLIER) and never updates
 * from post-launch wishlist activity. This preserves the
 * industry-standard interpretation of first-month conversion, which is
 * about pre-launch demand — post-launch wishlists represent 'saw the game,
 * not ready to buy' users, a different signal.
 *
 * For unreleased titles (releaseDate null OR releaseDate > today) the
 * forecast uses lifetimeNet (which equals preLaunchNet by construction
 * before release) and updates daily as wishlists accumulate.
 */
function computeSteamFirstMonthForecast(
  summary: SteamWishlistSummary,
  releaseDate: string | null,
): number | null {
  const wl = getForecastingWishlistCount(summary, releaseDate);
  return wl != null ? Math.round(wl * STEAM_WISHLIST_FIRST_MONTH_MULTIPLIER) : null;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Seed on startup
  seedDatabase();
  storage.seedDefaultSettings();

  // ─── Auth ──────────────────────────────────────────────────────────────────

  app.post("/api/auth/verify", (req, res) => {
    try {
      const { password } = req.body;
      const setting = storage.getSetting("app_password");
      const appPassword = setting?.value || "SABER";
      if (password === appPassword) {
        res.json({ success: true });
      } else {
        res.status(401).json({ success: false, error: "Invalid password" });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Settings ──────────────────────────────────────────────────────────────

  app.get("/api/settings", (_req, res) => {
    try {
      const settings = storage.getAllSettings();
      // Mask secret values — only return whether they are set or not
      const masked = settings.map(s => ({
        ...s,
        value: s.isSecret && s.value ? "••••••••" : s.value,
        isSet: !!s.value && s.value.length > 0,
      }));
      res.json(masked);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/settings/:key", (req, res) => {
    try {
      const { key } = req.params;
      const { value } = req.body;
      if (value === undefined) {
        return res.status(400).json({ error: "Value is required" });
      }
      const updated = storage.upsertSetting(key, value);
      res.json({
        ...updated,
        value: updated.isSecret && updated.value ? "••••••••" : updated.value,
        isSet: !!updated.value && updated.value.length > 0,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Products CRUD ─────────────────────────────────────────────────────────

  app.get("/api/products", (_req, res) => {
    try {
      const products = storage.getAllProducts();
      // Enrich with latest counts and forecast totals
      const enriched = products.map(p => {
        const latestSteamWl = storage.getLatestSteamWishlist(p.id);
        const latestPs5Wl = storage.getLatestPs5Wishlist(p.id);
        const latestPs5Pre = storage.getLatestPs5Prepurchase(p.id);
        const comps = storage.getCompForecasts(p.id);
        const compTotal = comps.reduce((sum, c) => sum + c.forecastUnits, 0);

        // v2.1 (2026-08-11): compute wishlist summary FIRST so we can feed
        // the pre-release-locked count into dynamic forecasts.
        const releaseDate = storage.getProductReleaseDate(p.id);
        const wishlistSummary = storage.getSteamWishlistSummary(p.id, releaseDate);
        const forecastingWl = getForecastingWishlistCount(wishlistSummary, releaseDate);
        const steamFirstMonthForecast = computeSteamFirstMonthForecast(
          wishlistSummary,
          releaseDate,
        );

        // Calculate dynamic forecasts at all timeframes.
        // Post-release: forecastingWl is LOCKED to pre-release count so
        // forecasts don't drift with post-release wishlist growth. If we
        // have >=30 days of Steam actuals, the calculator uses them as the
        // Steam Dyn 1st-Mo track AND dampen-propagates the lift to consoles.
        const platforms = JSON.parse(p.platforms);
        const steamActualFirstMonth = storage.getSteamActualFirstMonthBaseUnits(
          p.id, releaseDate,
        );
        const steamActualCumulative = storage.getSteamActualCumulativeBaseUnits(
          p.id, releaseDate,
        );
        const dynamicFull = calculateDynamicForecastsFull(
          platforms,
          forecastingWl,
          latestPs5Pre?.cumulativeCount ?? null,
          steamActualFirstMonth,
          steamActualCumulative,
        );
        const dynamicFirstMonthTotal = dynamicFull.reduce((sum, d) => sum + d.firstMonth, 0);
        const dynamicFirstYearTotal = dynamicFull.reduce((sum, d) => sum + d.firstYear, 0);
        const dynamicLtTotal = dynamicFull.reduce((sum, d) => sum + d.lifetime, 0);

        // v2.5 (2026-08-11): expose Steam-only forecast track so the summary
        // card can display 'Steam Dyn' rows separately from 'All Platforms'.
        const steamRow = dynamicFull.find(d => d.platform === "PC (Steam)");
        const steamDynamicFirstMonth = steamRow?.firstMonth ?? null;
        const steamDynamicFirstYear = steamRow?.firstYear ?? null;
        const steamDynamicLt = steamRow?.lifetime ?? null;

        // v3.7 (2026-08-12): flag whether the Steam Dyn track was driven by
        // actuals or wishlist. Also expose the raw actual and the console
        // lift factor so the UI can annotate the tiles.
        const wishlistBasedSteamForecast = forecastingWl != null
          ? Math.round(forecastingWl * 0.27)
          : null;
        const forecastMode: "actuals" | "wishlist" | "none" =
          steamActualFirstMonth != null && steamActualFirstMonth > 0
            ? "actuals"
            : forecastingWl != null ? "wishlist" : "none";
        const consoleLiftFactor = (forecastMode === "actuals"
            && wishlistBasedSteamForecast != null
            && wishlistBasedSteamForecast > 0)
          ? 1 + 0.5 * ((steamActualFirstMonth! / wishlistBasedSteamForecast) - 1)
          : 1;

        // Get latest revision total if any
        const latestRevision = storage.getLatestRevisionTotal(p.id);

        // v3.2 (2026-08-11): Steam Revenue split by release date. Feeds the
        // dashboard card 'Steam Revenue' triad (Pre-Release / Post-Release / Total).
        const steamRevenueSplit = storage.getSteamRevenueByReleaseSplit(p.id, releaseDate);

        // v3.9 (2026-08-12): blended GMV factor. Default is 0.66 (accounts
        // for regional discounting, store cuts before storefront splits,
        // long-tail discount waves). When we have Steam actuals we blend
        // 50/50 with the observed list-price-to-base-ASP ratio so titles
        // like SM2 (observed ratio ~0.77) shift toward reality without
        // over-committing to what may still be a partial sales window.
        const listPrice = p.targetRetailPriceUsd ?? 59.99;
        let gmvFactor = 0.66;
        let observedSteamAspRatio: number | null = null;
        if (steamRevenueSplit?.totalBaseAspUsd != null
            && steamRevenueSplit.totalBaseAspUsd > 0
            && listPrice > 0) {
          observedSteamAspRatio = steamRevenueSplit.totalBaseAspUsd / listPrice;
          gmvFactor = 0.5 * observedSteamAspRatio + 0.5 * 0.66;
        }

        return {
          ...p,
          platforms,
          perPlatformPricing: p.perPlatformPricing ? JSON.parse(p.perPlatformPricing) : null,
          latestSteamWishlistCount: wishlistSummary.lifetimeNet ?? latestSteamWl?.cumulativeCount ?? null,
          latestPs5WishlistCount: latestPs5Wl?.cumulativeCount ?? null,
          latestPs5PrepurchaseCount: latestPs5Pre?.cumulativeCount ?? null,
          compsForecastTotal: compTotal,
          latestRevisionTotal: latestRevision?.total ?? null,
          latestRevisionDate: latestRevision?.date ?? null,
          dynamicFirstMonthTotal,
          dynamicFirstYearTotal,
          dynamicLtTotal,
          // v2.1 fields
          steamWishlistSummary: wishlistSummary,
          steamFirstMonthForecast,
          // v2.5 fields: Steam-only forecast track (for 'Steam Dyn' rows)
          steamDynamicFirstMonth,
          steamDynamicFirstYear,
          steamDynamicLt,
          // v3.2 fields: Steam Revenue split (Pre-Release / Post-Release / Total)
          steamRevenueSplit,
          // v3.4 fields: per-platform dynamic forecast rows so the dashboard
          // card can show the split that rolls up into 'All Platforms'.
          // Each row is { platform, firstMonth, firstYear, lifetime }.
          dynamicPerPlatform: dynamicFull,
          // v3.7 fields: forecast provenance so the UI can label whether Dyn
          // came from actuals vs wishlist, and by how much consoles lifted.
          forecastMode,
          steamActualFirstMonthUnits: steamActualFirstMonth,
          wishlistBasedSteamFirstMonth: wishlistBasedSteamForecast,
          consoleLiftFactor,
          // v3.9 fields: blended GMV factor so the card revenue tiles can
          // use observed Steam ASP/list-price ratio when available.
          gmvFactor,
          observedSteamAspRatio,
        };
      });
      res.json(enriched);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/products", (req, res) => {
    try {
      const body = req.body;
      const isSaber = body.publisher === "Saber Interactive";
      const product = storage.createProduct({
        ...body,
        isSaberPublished: isSaber,
        platforms: typeof body.platforms === "string" ? body.platforms : JSON.stringify(body.platforms),
        perPlatformPricing: body.perPlatformPricing ? JSON.stringify(body.perPlatformPricing) : null,
      });

      // Auto-generate PLS milestones
      generateDefaultMilestones(product.id, product.releaseDate, product.playerFormat);

      // v3.9 (2026-08-12): Auto-trigger a Steam wishlist backfill immediately
      // whenever a new product is created with a steamAppId, so wishlist
      // counts (and the dynamic-forecast console rows that depend on them)
      // are populated without a manual step. Fire-and-forget — client can
      // poll GET /api/steam/backfill/:jobId if it wants progress, but the
      // dashboard doesn't need to wait on it.
      if (product.steamAppId) {
        const apiKeySetting = storage.getSetting("steam_api_key");
        const apiKey = apiKeySetting?.value;
        if (apiKey && apiKey.trim().length > 0) {
          const wlJob: BackfillJob = {
            id: makeJobId(),
            productId: product.id,
            status: "running",
            startedAt: new Date().toISOString(),
            completedAt: null,
            fromDate: null,
            toDate: null,
            totalDays: 0,
            daysProcessed: 0,
            daysSucceeded: 0,
            daysFailed: 0,
            errors: [],
            message: "Auto-triggered on product creation",
          };
          backfillJobs.set(wlJob.id, wlJob);
          runBackfillJob(wlJob, apiKey, product.steamAppId).catch((err: any) => {
            wlJob.status = "failed";
            wlJob.completedAt = new Date().toISOString();
            wlJob.message = `Unhandled backfill error: ${err?.message || String(err)}`;
          });
        }
      }

      // If auto_generate mode with comps data, generate forecasts
      if (body.forecastMode === "auto_generate" && body.steamForecast != null && body.ps5Forecast != null) {
        const platforms = JSON.parse(product.platforms);
        const forecasts = autoGenerateForecasts(platforms, body.steamForecast, body.ps5Forecast);
        storage.upsertCompForecasts(product.id, forecasts);
      } else if (body.compsForecasts) {
        // Manual mode
        const platforms = JSON.parse(product.platforms);
        const mix = getAdjustedPlatformMix(platforms);
        const forecasts = body.compsForecasts.map((f: any) => ({
          platform: f.platform,
          forecastUnits: f.forecastUnits,
          adjustedPct: Math.round((mix[f.platform] || 0) * 10000) / 100,
        }));
        storage.upsertCompForecasts(product.id, forecasts);
      }

      res.status(201).json({
        ...product,
        platforms: JSON.parse(product.platforms),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/products/:id", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const product = storage.getProduct(id);
      if (!product) return res.status(404).json({ error: "Product not found" });

      const latestSteamWl = storage.getLatestSteamWishlist(id);
      const latestSteamPre = storage.getLatestSteamPrepurchase(id);
      const latestPs5Wl = storage.getLatestPs5Wishlist(id);
      const latestPs5Pre = storage.getLatestPs5Prepurchase(id);
      const comps = storage.getCompForecasts(id);
      const dynamicForecasts = storage.getLatestDynamicForecasts(id);

      // v2.1 (2026-08-11): compute wishlist summary FIRST so we can feed
      // the pre-release-locked count into all dynamic-forecast call sites.
      const releaseDateForSummary = storage.getProductReleaseDate(id);
      const steamWishlistSummary = storage.getSteamWishlistSummary(id, releaseDateForSummary);
      const forecastingWl = getForecastingWishlistCount(steamWishlistSummary, releaseDateForSummary);
      const steamFirstMonthForecast = computeSteamFirstMonthForecast(
        steamWishlistSummary,
        releaseDateForSummary,
      );

      // Calculate dynamic forecasts on-the-fly if no stored ones.
      // Uses forecastingWl (LOCKED to pre-release count once released).
      const platforms = JSON.parse(product.platforms);
      let dynamicData = dynamicForecasts;
      if (dynamicData.length === 0 && (latestSteamWl || latestPs5Pre)) {
        const calculated = calculateDynamicForecasts(
          platforms,
          forecastingWl,
          latestPs5Pre?.cumulativeCount ?? null,
        );
        dynamicData = calculated.map(c => ({
          id: 0,
          productId: id,
          date: new Date().toISOString().split("T")[0],
          platform: c.platform,
          forecastUnits: c.forecastUnits,
          steamWishlistCountUsed: forecastingWl,
          ps5PrepurchaseCountUsed: latestPs5Pre?.cumulativeCount ?? null,
          createdAt: new Date().toISOString(),
        }));
      }

      // Get prepurchase start milestone info
      const plsMilestones = storage.getPlsMilestones(id);
      const prepurchaseStartMilestone = plsMilestones.find(m => m.name === "Prepurchase Start");
      const prepurchaseStartDate = prepurchaseStartMilestone?.actualDate ?? null;
      const prepurchaseTargetDate = prepurchaseStartMilestone?.targetDate ?? null;

      // Get forecast revisions grouped by date
      const allRevisions = storage.getForecastRevisions(id);
      const revisionGrouped: Record<string, { date: string; label: string; forecasts: Record<string, number> }> = {};
      for (const r of allRevisions) {
        if (!revisionGrouped[r.revisionDate]) {
          revisionGrouped[r.revisionDate] = {
            date: r.revisionDate,
            label: r.revisionLabel || r.revisionDate,
            forecasts: {},
          };
        }
        revisionGrouped[r.revisionDate].forecasts[r.platform] = r.forecastUnits;
      }
      const forecastRevisions = Object.values(revisionGrouped).sort((a, b) => a.date.localeCompare(b.date));

      // Calculate full per-platform forecasts (first month, 1yr, LT).
      // v3.7: pass Steam actual first-month post-release when available so
      // the Dyn track is actuals-driven and console lift is dampen-propagated.
      const steamActualFirstMonthUnits = storage.getSteamActualFirstMonthBaseUnits(
        id, releaseDateForSummary,
      );
      const steamActualCumulativeUnits = storage.getSteamActualCumulativeBaseUnits(
        id, releaseDateForSummary,
      );
      const dynamicFullForecasts = calculateDynamicForecastsFull(
        platforms,
        forecastingWl,
        latestPs5Pre?.cumulativeCount ?? null,
        steamActualFirstMonthUnits,
        steamActualCumulativeUnits,
      );

      // v3.9 (2026-08-12): compute blended GMV factor for revenue tiles.
      // Mirrors the same math the list endpoint uses.
      const pdpSteamRev = storage.getSteamRevenueByReleaseSplit(id, releaseDateForSummary);
      const pdpListPrice = product.targetRetailPriceUsd ?? 59.99;
      let pdpGmvFactor = 0.66;
      let pdpObservedSteamAspRatio: number | null = null;
      if (pdpSteamRev?.totalBaseAspUsd != null
          && pdpSteamRev.totalBaseAspUsd > 0
          && pdpListPrice > 0) {
        pdpObservedSteamAspRatio = pdpSteamRev.totalBaseAspUsd / pdpListPrice;
        pdpGmvFactor = 0.5 * pdpObservedSteamAspRatio + 0.5 * 0.66;
      }

      res.json({
        ...product,
        gmvFactor: pdpGmvFactor,
        observedSteamAspRatio: pdpObservedSteamAspRatio,
        platforms,
        perPlatformPricing: product.perPlatformPricing ? JSON.parse(product.perPlatformPricing) : null,
        latestSteamWishlistCount: steamWishlistSummary.lifetimeNet ?? latestSteamWl?.cumulativeCount ?? null,
        latestSteamPrepurchaseCount: latestSteamPre?.cumulativeCount ?? null,
        latestPs5WishlistCount: latestPs5Wl?.cumulativeCount ?? null,
        latestPs5PrepurchaseCount: latestPs5Pre?.cumulativeCount ?? null,
        compsForecasts: comps,
        dynamicForecasts: dynamicData,
        dynamicFullForecasts,  // per-platform {firstMonth, firstYear, lifetime}
        forecastRevisions,
        steamFirstMonthForecast,
        // v2.1 fields: full wishlist summary object with pre-launch,
        // post-launch, lifetime, day-over-day delta, and staleness flag.
        // See SteamWishlistSummary type in storage.ts for field docs.
        steamWishlistSummary,
        ps5FirstMonthForecast: latestPs5Pre ? Math.round(latestPs5Pre.cumulativeCount * 8) : null,
        prepurchaseStartDate,
        prepurchaseTargetDate,
        prepurchaseActive: !!prepurchaseStartDate,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/products/:id", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const body = req.body;

      // Check if platforms are being changed (new platform added)
      const existingProduct = storage.getProduct(id);
      if (!existingProduct) return res.status(404).json({ error: "Product not found" });

      const oldPlatforms: string[] = JSON.parse(existingProduct.platforms);
      let newPlatformsArray: string[] | null = null;

      if (body.platforms && typeof body.platforms !== "string") {
        newPlatformsArray = body.platforms;
        body.platforms = JSON.stringify(body.platforms);
      } else if (body.platforms && typeof body.platforms === "string") {
        newPlatformsArray = JSON.parse(body.platforms);
      }

      if (body.perPlatformPricing && typeof body.perPlatformPricing !== "string") {
        body.perPlatformPricing = JSON.stringify(body.perPlatformPricing);
      }
      if (body.publisher !== undefined) {
        body.isSaberPublished = body.publisher === "Saber Interactive";
      }

      const updated = storage.updateProduct(id, body);
      if (!updated) return res.status(404).json({ error: "Product not found" });

      // If platforms changed, add comps entries for new platforms and recalculate dynamic forecasts
      if (newPlatformsArray) {
        const addedPlatforms = newPlatformsArray.filter(p => !oldPlatforms.includes(p));

        if (addedPlatforms.length > 0) {
          // Get existing comps and add entries for new platforms with 0 units
          const existingComps = storage.getCompForecasts(id);
          const mix = getAdjustedPlatformMix(newPlatformsArray);
          const allForecasts = [
            ...existingComps.map(c => ({
              platform: c.platform,
              forecastUnits: c.forecastUnits,
              adjustedPct: Math.round((mix[c.platform] || 0) * 10000) / 100,
            })),
            ...addedPlatforms.map(p => ({
              platform: p,
              forecastUnits: 0,
              adjustedPct: Math.round((mix[p] || 0) * 10000) / 100,
            })),
          ];
          storage.upsertCompForecasts(id, allForecasts);

          // Recalculate dynamic forecasts with new platform mix.
          // v2.1: use pre-release-locked wishlist count once title has released.
          const latestSteamWl = storage.getLatestSteamWishlist(id);
          const latestPs5Pre = storage.getLatestPs5Prepurchase(id);
          if (latestSteamWl || latestPs5Pre) {
            const releaseDateForForecast = storage.getProductReleaseDate(id);
            const wlSummary = storage.getSteamWishlistSummary(id, releaseDateForForecast);
            const forecastingWl = getForecastingWishlistCount(wlSummary, releaseDateForForecast);
            const dynamicForecasts = calculateDynamicForecasts(
              newPlatformsArray,
              forecastingWl,
              latestPs5Pre?.cumulativeCount ?? null,
            );
            const today = new Date().toISOString().split("T")[0];
            storage.upsertDynamicForecasts(dynamicForecasts.map(d => ({
              productId: id,
              date: today,
              platform: d.platform,
              forecastUnits: d.forecastUnits,
              steamWishlistCountUsed: forecastingWl,
              ps5PrepurchaseCountUsed: latestPs5Pre?.cumulativeCount ?? null,
            })));
          }
        }
      }

      res.json({
        ...updated,
        platforms: JSON.parse(updated.platforms),
        perPlatformPricing: updated.perPlatformPricing ? JSON.parse(updated.perPlatformPricing) : null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/products/:id", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      storage.deleteProduct(id);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Comps Forecasts ────────────────────────────────────────────────────────

  app.get("/api/products/:id/forecasts/comps", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const forecasts = storage.getCompForecasts(id);
      res.json(forecasts);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/products/:id/forecasts/comps", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const product = storage.getProduct(id);
      if (!product) return res.status(404).json({ error: "Product not found" });
      
      const body = req.body;
      const platforms = JSON.parse(product.platforms);

      if (body.mode === "auto_generate") {
        const forecasts = autoGenerateForecasts(platforms, body.steamForecast, body.ps5Forecast);
        const result = storage.upsertCompForecasts(id, forecasts);
        res.json(result);
      } else {
        const mix = getAdjustedPlatformMix(platforms);
        const forecasts = body.forecasts.map((f: any) => ({
          platform: f.platform,
          forecastUnits: f.forecastUnits,
          adjustedPct: Math.round((mix[f.platform] || 0) * 10000) / 100,
        }));
        const result = storage.upsertCompForecasts(id, forecasts);
        res.json(result);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Dynamic Forecasts ───────────────────────────────────────────────────────

  app.get("/api/products/:id/forecasts/dynamic", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const product = storage.getProduct(id);
      if (!product) return res.status(404).json({ error: "Product not found" });

      const platforms = JSON.parse(product.platforms);
      const latestPs5Pre = storage.getLatestPs5Prepurchase(id);

      // v2.1: use pre-release-locked wishlist count once title has released.
      const releaseDateForForecast = storage.getProductReleaseDate(id);
      const wlSummary = storage.getSteamWishlistSummary(id, releaseDateForForecast);
      const forecastingWl = getForecastingWishlistCount(wlSummary, releaseDateForForecast);

      const forecasts = calculateDynamicForecasts(
        platforms,
        forecastingWl,
        latestPs5Pre?.cumulativeCount ?? null,
      );

      res.json(forecasts);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/products/:id/forecasts/dynamic/history", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const history = storage.getDynamicForecasts(id);
      res.json(history);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Forecast Revisions ─────────────────────────────────────────────────────

  app.post("/api/products/:id/forecasts/revisions", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const product = storage.getProduct(id);
      if (!product) return res.status(404).json({ error: "Product not found" });

      const { forecasts, revisionDate } = req.body;
      if (!forecasts || !Array.isArray(forecasts)) {
        return res.status(400).json({ error: "forecasts array is required" });
      }

      const date = revisionDate || new Date().toISOString().split("T")[0];
      // Format label: "Revised Biz Forecast (Mar 30, 2026)"
      const d = new Date(date + "T12:00:00");
      const label = `Revised (${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`;

      const result = storage.createForecastRevision(id, forecasts, date, label);
      res.status(201).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/products/:id/forecasts/revisions", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const allRevisions = storage.getForecastRevisions(id);

      // Group by revision_date
      const grouped: Record<string, { date: string; label: string; forecasts: Record<string, number> }> = {};
      for (const r of allRevisions) {
        if (!grouped[r.revisionDate]) {
          grouped[r.revisionDate] = {
            date: r.revisionDate,
            label: r.revisionLabel || r.revisionDate,
            forecasts: {},
          };
        }
        grouped[r.revisionDate].forecasts[r.platform] = r.forecastUnits;
      }

      const revisions = Object.values(grouped).sort((a, b) => a.date.localeCompare(b.date));
      res.json({ revisions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Steam Wishlists ─────────────────────────────────────────────────────────

  app.get("/api/products/:id/steam/wishlists", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const data = storage.getSteamWishlists(id);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/products/:id/steam/wishlists", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const result = storage.addSteamWishlist({
        productId: id,
        ...req.body,
      });
      res.status(201).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Steam Prepurchases ──────────────────────────────────────────────────────

  // v3.3 (2026-08-11): steam/prepurchases now returns a MERGED series:
  //   pre-release: daily prepurchase cumulative rows (from Steamworks API)
  //   post-release: monthly steam_sales_daily rows (base + dlc), converted
  //                 into a running cumulative unit total that continues from
  //                 the last prepurchase datapoint
  //
  // This lets the pre-purchase chart become a continuous 'Pre-Purchase +
  // Post-Release Sales' timeline with the release date as an even reference
  // line dividing the two segments.
  app.get("/api/products/:id/steam/prepurchases", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const plsMilestones = storage.getPlsMilestones(id);
      const prepurchaseStart = plsMilestones.find(m => m.name === "Prepurchase Start");
      const prepurchaseStartDate = prepurchaseStart?.actualDate ?? null;
      const releaseDate = storage.getProductReleaseDate(id);

      // v3.5 (2026-08-11): merged series now includes BASE units only, and
      // covers both pre-release and post-release from steam_sales_daily as a
      // single series. Previous version only pulled pre-purchase telemetry
      // for the pre-release segment — which dropped pre-release SALES rows
      // for titles like SM2 that have portal sales data but no Saber pre-
      // purchase feed. DLC is excluded from this chart because DLC unit
      // counts distort the base-game purchase narrative (some 'DLC' rows in
      // pre-release windows are bundle/pre-order artifacts).
      //
      // The result is: one cumulative curve of BASE game units across the
      // entire period, from first available data through the latest ingest.
      // The release-date marker splits the visual into pre / post regions.

      // Prefer sales data (source of truth) when we have ANY. Fall back to
      // pre-purchase telemetry only when no sales rows exist for the product.
      const salesRows = storage.getSteamSales(id);
      const hasSalesData = salesRows.length > 0;

      let merged: { date: string; cumulativeCount: number; dailyDelta: number }[] = [];

      if (hasSalesData) {
        // Aggregate to (date -> base net units) — base only, dlc excluded.
        const perDate = new Map<string, number>();
        for (const r of salesRows) {
          if (r.skuGroup !== "base") continue;
          perDate.set(r.date, (perDate.get(r.date) ?? 0) + r.netUnits);
        }

        let running = 0;
        const sortedDates = Array.from(perDate.keys()).sort();
        for (const date of sortedDates) {
          const units = perDate.get(date)!;
          running += units;
          merged.push({
            date,
            cumulativeCount: running,
            dailyDelta: units,
          });
        }
      } else if (prepurchaseStartDate) {
        // Fall back to pre-purchase telemetry for Saber titles that don't have
        // sales data yet (pre-launch state).
        const allPrepurchase = storage.getSteamPrepurchases(id);
        merged = allPrepurchase
          .filter(d => d.date >= prepurchaseStartDate)
          .map(d => ({
            date: d.date,
            cumulativeCount: d.cumulativeCount,
            dailyDelta: d.dailyDelta,
          }));
      }

      res.json(merged);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/products/:id/steam/prepurchases", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      // Validate prepurchase period is active before accepting data
      const plsMilestones = storage.getPlsMilestones(id);
      const prepurchaseStart = plsMilestones.find(m => m.name === "Prepurchase Start");
      if (!prepurchaseStart?.actualDate) {
        return res.status(400).json({ error: "Cannot add pre-purchase data: the pre-purchase period has not started yet. Set an actual date on the Prepurchase Start milestone first." });
      }
      const result = storage.addSteamPrepurchase({
        productId: id,
        ...req.body,
      });
      res.status(201).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Steam Wishlist Reporting (IPartnerFinancialsService) + Backfill ───────
  //
  // New in the Steam Partner API rebuild (2026-07-22). Exposes:
  //   - GET  /api/products/:id/steam-wishlist-daily  — raw daily-delta rows
  //     from the new steam_wishlist_reporting_daily table, with a computed
  //     runningCumulative field per row.
  //   - POST /api/steam/backfill/:productId — kicks off an async historical
  //     backfill (rate-limited to Steam's Financial API) and returns a job id.
  //   - GET  /api/steam/backfill/:jobId — poll job status.
  //
  // Backfill jobs are tracked in-memory only (no persistence needed per spec).

  interface BackfillJob {
    id: string;
    productId: number;
    status: "running" | "completed" | "failed";
    startedAt: string;
    completedAt: string | null;
    fromDate: string | null;
    toDate: string | null;
    totalDays: number;
    daysProcessed: number;
    daysSucceeded: number;
    daysFailed: number;
    errors: Array<{ date: string; error: string }>;
    message: string;
  }

  const backfillJobs = new Map<string, BackfillJob>();

  // Rate limit: Steam's Partner Financials API docs mention excessive calls
  // will lead to WebAPI key rate limiting. We use 1 request/sec (safer than
  // the 2/sec ceiling mentioned in the docs) between backfill calls.
  const BACKFILL_DELAY_MS = 1000;

  function makeJobId(): string {
    return `steam-backfill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function runBackfillJob(job: BackfillJob, apiKey: string, appId: string) {
    try {
      // Canonical fetch (yesterday) to discover app_min_date.
      const yesterday = getYesterdayGmtDateString();
      const canonical = await fetchSteamWishlistReportingDay(apiKey, appId, yesterday);

      if (!canonical.ok) {
        job.status = "failed";
        job.completedAt = new Date().toISOString();
        job.message = `Could not fetch canonical date (${yesterday}) to discover app_min_date: ${canonical.error}`;
        return;
      }

      persistSteamWishlistReportingDay(job.productId, yesterday, canonical.data, "api");
      job.daysProcessed++;
      job.daysSucceeded++;

      const appMinDate = canonical.data.response.app_min_date;
      if (!appMinDate) {
        // Assumption: if Steam doesn't return app_min_date, we can't safely
        // determine how far back to backfill. We stop here rather than
        // guessing an arbitrary window, but the canonical (yesterday) day
        // fetched above is still saved.
        job.status = "completed";
        job.completedAt = new Date().toISOString();
        job.fromDate = yesterday;
        job.toDate = yesterday;
        job.totalDays = 1;
        job.message = "app_min_date was null in the API response — backfill bounds unknown, so only yesterday's canonical day was fetched. Re-run once Steam reports a valid app_min_date.";
        return;
      }

      job.fromDate = appMinDate;
      job.toDate = yesterday;

      // Build the list of remaining dates: [appMinDate, yesterday), excluding
      // yesterday itself (already fetched above).
      const dates: string[] = [];
      let cursor = new Date(appMinDate + "T00:00:00Z");
      const end = new Date(yesterday + "T00:00:00Z");
      while (cursor.getTime() < end.getTime()) {
        dates.push(cursor.toISOString().split("T")[0]);
        cursor = new Date(cursor.getTime() + 86400000);
      }

      job.totalDays = dates.length + 1; // +1 for the canonical day already done

      for (const date of dates) {
        // Idempotent: upsert on unique (productId, date) — safe to re-run.
        await new Promise(resolve => setTimeout(resolve, BACKFILL_DELAY_MS));
        try {
          const result = await fetchSteamWishlistReportingDay(apiKey, appId, date);
          job.daysProcessed++;
          if (result.ok) {
            // "api" source: this IS a live API call (just historical), not a
            // CSV import. "csv-backfill" is reserved for manually-imported
            // Steamworks export files, which this endpoint does not handle.
            persistSteamWishlistReportingDay(job.productId, date, result.data, "api");
            job.daysSucceeded++;
          } else {
            job.daysFailed++;
            job.errors.push({ date, error: result.error });
          }
        } catch (err: any) {
          job.daysProcessed++;
          job.daysFailed++;
          job.errors.push({ date, error: err?.message || String(err) });
        }
      }

      job.status = "completed";
      job.completedAt = new Date().toISOString();
      job.message = `Backfilled ${job.daysSucceeded}/${job.totalDays} days from ${job.fromDate} to ${job.toDate}${job.daysFailed > 0 ? ` (${job.daysFailed} failed)` : ""}`;
    } catch (err: any) {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      job.message = `Backfill crashed: ${err?.message || String(err)}`;
    }
  }

  app.post("/api/steam/backfill/:productId", async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      const product = storage.getProduct(productId);
      if (!product) return res.status(404).json({ error: "Product not found" });
      if (!product.steamAppId) return res.status(400).json({ error: "Product has no steamAppId configured" });

      const apiKeySetting = storage.getSetting("steam_api_key");
      const apiKey = apiKeySetting?.value;
      if (!apiKey || apiKey.trim().length === 0) {
        return res.status(400).json({ error: "No Steam API key configured in Settings" });
      }

      const job: BackfillJob = {
        id: makeJobId(),
        productId,
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        fromDate: null,
        toDate: null,
        totalDays: 0,
        daysProcessed: 0,
        daysSucceeded: 0,
        daysFailed: 0,
        errors: [],
        message: "Backfill started",
      };
      backfillJobs.set(job.id, job);

      // Fire and forget — client polls GET /api/steam/backfill/:jobId
      runBackfillJob(job, apiKey, product.steamAppId).catch(err => {
        job.status = "failed";
        job.completedAt = new Date().toISOString();
        job.message = `Unhandled backfill error: ${err?.message || String(err)}`;
      });

      res.status(202).json({ jobId: job.id, status: job.status, message: "Backfill started" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/steam/backfill/:jobId", (req, res) => {
    const job = backfillJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Backfill job not found" });
    res.json(job);
  });

  // ─── Steam Sales CSV upload (v3.0, 2026-08-11) ──────────────────────
  //
  // Accepts a raw CSV body (text/csv or text/plain) and ingests it into
  // steam_sales_daily aggregated per (date, sku_group). Creates an audit
  // row in steam_sales_upload_batches. Response includes the parsed
  // preview so the UI can show the user what got ingested.
  app.post("/api/products/:id/steam/sales-upload", async (req, res) => {
    try {
      const productId = parseInt(req.params.id);
      const product = storage.getProduct(productId);
      if (!product) return res.status(404).json({ error: "Product not found" });

      // Accept raw CSV in body. Express default json parser won't parse
      // text/csv, so we ensure a text/* parser is registered for this route.
      const rawCsv = typeof req.body === "string"
        ? req.body
        : (req.body && typeof req.body.csv === "string" ? req.body.csv : "");
      if (!rawCsv || rawCsv.length < 20) {
        return res.status(400).json({ error: "Empty or missing CSV body" });
      }

      const filename = typeof req.query.filename === "string" ? req.query.filename : "upload.csv";
      const batchId = `sales-${productId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Parse. Uses gameTitle from the product to classify SKUs into
      // base/dlc/other buckets.
      const { parseSteamSalesCsv } = await import("./steam-sales-csv");
      const parsed = parseSteamSalesCsv(rawCsv, productId, product.title, () => new Date().toISOString(), batchId);

      // Persist upload batch record BEFORE writing rows so we have a paper
      // trail even if the sales insert fails partway.
      storage.createSteamSalesUploadBatch({
        id: batchId,
        productId,
        filename,
        fileBytes: Buffer.byteLength(rawCsv, "utf8"),
        reportDateStart: parsed.reportDateStart,
        reportDateEnd: parsed.reportDateEnd,
        publisherName: parsed.publisherName,
        rowsParsed: parsed.totalRawRows,
        rowsIngested: parsed.ingestedRows.length,
        rowsSkipped: parsed.skipped.retail + parsed.skipped.zeroUnits + parsed.skipped.unclassified,
        skippedReason: JSON.stringify(parsed.skipped),
        uploadedBy: null,
      });

      const upsertResult = parsed.ingestedRows.length > 0
        ? storage.upsertSteamSalesRows(parsed.ingestedRows)
        : { inserted: 0, updated: 0 };

      res.json({
        batchId,
        publisherName: parsed.publisherName,
        reportDateStart: parsed.reportDateStart,
        reportDateEnd: parsed.reportDateEnd,
        rowsParsed: parsed.totalRawRows,
        rowsIngested: parsed.ingestedRows.length,
        rowsInserted: upsertResult.inserted,
        rowsUpdated: upsertResult.updated,
        skipped: parsed.skipped,
        errors: parsed.errors,
        perSkuBreakdown: parsed.perSkuBreakdown,
      });
    } catch (err: any) {
      console.error(`[routes] sales-upload error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Read: daily sales rows for a product (used by the chart on the card).
  app.get("/api/products/:id/steam/sales-daily", (req, res) => {
    try {
      const productId = parseInt(req.params.id);
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      const until = typeof req.query.until === "string" ? req.query.until : undefined;
      const rows = storage.getSteamSales(productId, { since, until });
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // v3.10 (2026-08-12): daily Steam BASE + DLC revenue (USD) as a
  // time-series ready for the chart modal / sparkline. Same response
  // shape as /steam/wishlists and /steam/prepurchases so the existing
  // TimeSeriesChart component can render it without changes.
  //
  // dailyDelta = revenue on that calendar day (base + dlc SKUs summed).
  // cumulativeCount = running-total revenue from first row through that day.
  //
  // Excludes 'other' skuGroup (soundtrack/artbook) so the number aligns with
  // the Steam Sales card's tracked revenue.
  app.get("/api/products/:id/steam/revenue-daily", (req, res) => {
    try {
      const productId = parseInt(req.params.id);
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      const until = typeof req.query.until === "string" ? req.query.until : undefined;
      const rows = storage.getSteamSales(productId, { since, until });

      // Roll up daily revenue (base + dlc). Multiple rows can share a date
      // when both base and dlc SKUs sold that day.
      const byDate = new Map<string, number>();
      for (const r of rows) {
        if (r.skuGroup !== "base" && r.skuGroup !== "dlc") continue;
        byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.netRevenueUsd);
      }
      const dates = Array.from(byDate.keys()).sort();
      let running = 0;
      const out = dates.map((date) => {
        const dailyDelta = Math.round(byDate.get(date)! * 100) / 100;
        running = Math.round((running + dailyDelta) * 100) / 100;
        return { date, cumulativeCount: running, dailyDelta };
      });
      res.json(out);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Read: rolled-up summary for the product-detail sales card.
  app.get("/api/products/:id/steam/sales-summary", (req, res) => {
    try {
      const productId = parseInt(req.params.id);
      const summary = storage.getSteamSalesSummary(productId);
      const batches = storage.getSteamSalesUploadBatches(productId);
      res.json({ summary, recentBatches: batches.slice(0, 10) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Steamworks Portal Fetcher (v3.1, 2026-08-11) ─────────────────
  //
  // For products where the CSV export path is empty (e.g. Space Marine 2
  // whose sales record lives under Focus Entertainment's publisher account,
  // not Mad Dog Games'). Uses the user's logged-in Steamworks session
  // cookie to fetch the app-details page HTML and parse the rendered
  // numbers.

  // GET session cookie metadata (never returns the raw value).
  app.get("/api/steam/session", (_req, res) => {
    const session = storage.getSteamworksSession("default");
    if (!session) {
      return res.json({ configured: false });
    }
    // Proactive expiry detection: `lastVerifiedResult` carries the literal
    // "Session expired (redirected to ...)" string from ingestSteamSales()
    // when the /session expired/i pattern matches. Surfaced here as a
    // computed boolean so the frontend (Settings card + app-wide layout
    // banner) doesn't have to duplicate that regex.
    const isExpired = !!(session.lastVerifiedResult && /session expired/i.test(session.lastVerifiedResult));
    res.json({
      configured: true,
      loggedInAs: session.loggedInAs,
      lastVerifiedAt: session.lastVerifiedAt,
      lastVerifiedResult: session.lastVerifiedResult,
      alertSentAt: session.alertSentAt,
      isExpired,
      cookiePreview: session.cookieValue.slice(0, 30) + "...",
      cookieByteLength: session.cookieValue.length,
      updatedAt: session.updatedAt,
    });
  });

  // POST/PUT: upsert session cookie. Body: { cookieValue: string, loggedInAs?: string }
  app.post("/api/steam/session", (req, res) => {
    try {
      const cookieValue = String(req.body?.cookieValue ?? "").trim();
      if (!cookieValue || cookieValue.length < 20) {
        return res.status(400).json({ error: "cookieValue is required (min 20 chars)" });
      }
      const loggedInAs = typeof req.body?.loggedInAs === "string" ? req.body.loggedInAs.trim() : null;
      const session = storage.upsertSteamworksSession({
        id: "default",
        cookieValue,
        loggedInAs,
        lastVerifiedAt: null,
        lastVerifiedResult: null,
      });
      // Fresh cookie pasted in — reset the expiry-alert cooldown so the
      // next failure (a new episode) alerts immediately rather than
      // inheriting a stale cooldown from before this save.
      storage.setSteamworksSessionAlertSent("default", null);
      res.json({
        configured: true,
        loggedInAs: session.loggedInAs,
        cookieByteLength: session.cookieValue.length,
        updatedAt: session.updatedAt,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/steam/session", (_req, res) => {
    const removed = storage.deleteSteamworksSession("default");
    res.json({ removed });
  });

  // POST: test-fetch endpoint. Verifies the session cookie works and
  // returns the parsed page for one product/date range without writing
  // anything to the sales table. Used by the settings UI to sanity-check
  // before enabling the recurring monthly cron.
  app.post("/api/steam/portal/test-fetch", async (req, res) => {
    try {
      const productId = parseInt(String(req.body?.productId ?? "0"));
      const product = storage.getProduct(productId);
      if (!product) return res.status(404).json({ error: "Product not found" });
      if (!product.steamAppId) return res.status(400).json({ error: "Product has no steamAppId" });

      const session = storage.getSteamworksSession("default");
      if (!session) return res.status(400).json({ error: "No Steamworks session cookie configured" });

      const dateStart = String(req.body?.dateStart ?? "").trim();
      const dateEnd = String(req.body?.dateEnd ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStart) || !/^\d{4}-\d{2}-\d{2}$/.test(dateEnd)) {
        return res.status(400).json({ error: "dateStart and dateEnd required (YYYY-MM-DD)" });
      }

      const { fetchPortalPage } = await import("./steamworks-portal");
      const result = await fetchPortalPage({
        appId: Number(product.steamAppId),
        dateStart,
        dateEnd,
        cookieHeader: session.cookieValue,
      });

      // Update session verification status based on the fetch result.
      const nowIso = new Date().toISOString();
      storage.upsertSteamworksSession({
        id: "default",
        cookieValue: session.cookieValue,
        loggedInAs: session.loggedInAs,
        lastVerifiedAt: nowIso,
        lastVerifiedResult: result.ok ? "ok" : `error: ${(result.error ?? "unknown").slice(0, 200)}`,
      });

      res.json(result);
    } catch (err: any) {
      console.error(`[routes] portal test-fetch error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // POST: monthly ingest for one product. Fetches the previous full month
  // (or a custom range) and writes to steam_sales_daily as source=portal_fetch.
  // Idempotent — uses the same upsert path as CSV uploads.
  app.post("/api/products/:id/steam/portal-fetch", async (req, res) => {
    try {
      const productId = parseInt(req.params.id);
      const product = storage.getProduct(productId);
      if (!product) return res.status(404).json({ error: "Product not found" });
      if (!product.steamAppId) return res.status(400).json({ error: "Product has no steamAppId" });

      const session = storage.getSteamworksSession("default");
      if (!session) return res.status(400).json({ error: "No Steamworks session cookie configured" });

      // Default range: previous full month. Overridable via body.
      const now = new Date();
      const lastDayPrev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
      const firstDayPrev = new Date(Date.UTC(lastDayPrev.getUTCFullYear(), lastDayPrev.getUTCMonth(), 1));
      const defaultStart = firstDayPrev.toISOString().slice(0, 10);
      const defaultEnd = lastDayPrev.toISOString().slice(0, 10);
      const dateStart = String(req.body?.dateStart ?? defaultStart);
      const dateEnd = String(req.body?.dateEnd ?? defaultEnd);

      const { fetchPortalPage, portalToSalesRows } = await import("./steamworks-portal");
      const result = await fetchPortalPage({
        appId: Number(product.steamAppId),
        dateStart,
        dateEnd,
        cookieHeader: session.cookieValue,
      });

      if (!result.ok || !result.parsed) {
        // Record the failed verification
        const nowIso = new Date().toISOString();
        storage.upsertSteamworksSession({
          id: "default",
          cookieValue: session.cookieValue,
          loggedInAs: session.loggedInAs,
          lastVerifiedAt: nowIso,
          lastVerifiedResult: `error: ${(result.error ?? "unknown").slice(0, 200)}`,
        });
        return res.status(502).json({ ok: false, error: result.error, httpStatus: result.httpStatus });
      }

      const batchId = `portal-${productId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const rows = portalToSalesRows(result.parsed, productId, dateEnd, batchId);

      storage.createSteamSalesUploadBatch({
        id: batchId,
        productId,
        filename: `portal-fetch-${dateStart}-to-${dateEnd}.html`,
        fileBytes: result.htmlBytes ?? 0,
        reportDateStart: dateStart,
        reportDateEnd: dateEnd,
        publisherName: null, // portal source; unknown at fetch time
        rowsParsed: 1,
        rowsIngested: rows.length,
        rowsSkipped: 0,
        skippedReason: null,
        uploadedBy: "portal-fetcher",
      });

      const upsertResult = rows.length > 0
        ? storage.upsertSteamSalesRows(rows)
        : { inserted: 0, updated: 0 };

      // Record successful verification
      const nowIso = new Date().toISOString();
      storage.upsertSteamworksSession({
        id: "default",
        cookieValue: session.cookieValue,
        loggedInAs: session.loggedInAs,
        lastVerifiedAt: nowIso,
        lastVerifiedResult: "ok",
      });

      res.json({
        ok: true,
        batchId,
        dateStart,
        dateEnd,
        rowsIngested: rows.length,
        rowsInserted: upsertResult.inserted,
        rowsUpdated: upsertResult.updated,
        parsed: result.parsed,
      });
    } catch (err: any) {
      console.error(`[routes] portal-fetch error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // POST: bulk monthly ingest for every product with a steamAppId.
  // Used by the recurring cron (see cron config) but also invokable
  // manually for testing.
  // ─── Portal DAILY backfill (v3.4, 2026-08-11) ────────────────────────────
  //
  // Kicks off an async job that walks a date range one day at a time, fetching
  // portal single-day snapshots. Also purges the coarser monthly-rollup rows
  // for the same window so the new daily rows replace them cleanly. Job is
  // pollable and stored in-memory.

  interface PortalDailyJob {
    id: string;
    productId: number;
    productTitle: string;
    status: "running" | "completed" | "failed";
    startedAt: string;
    completedAt: string | null;
    fromDate: string;
    toDate: string;
    totalDays: number;
    daysProcessed: number;
    daysSucceeded: number;
    daysFailed: number;
    errors: Array<{ date: string; error: string }>;
    message: string;
    batchesPurged: number;
  }

  const portalDailyJobs = new Map<string, PortalDailyJob>();
  const PORTAL_DAILY_DELAY_MS = 1800; // ~2s stagger — gentle on Steamworks

  function makePortalDailyJobId(): string {
    return `portal-daily-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function runPortalDailyJob(job: PortalDailyJob) {
    try {
      const product = storage.getProduct(job.productId);
      const session = storage.getSteamworksSession("default");
      if (!product || !product.steamAppId) {
        job.status = "failed";
        job.message = "Product not found or has no steamAppId";
        job.completedAt = new Date().toISOString();
        return;
      }
      if (!session) {
        job.status = "failed";
        job.message = "No Steamworks session cookie configured";
        job.completedAt = new Date().toISOString();
        return;
      }

      // Purge existing portal_fetch batches for this product that fall inside
      // the requested window. Monthly rollup batches will have filenames like
      // 'monthly-portal-YYYY-MM-DD-to-YYYY-MM-DD.html' or 'portal-fetch-...'.
      // We only delete batches whose entire window is inside job.fromDate/toDate.
      const existingBatches = storage.getSteamSalesUploadBatches(job.productId);
      for (const b of existingBatches) {
        const overlapsWindow = b.reportDateStart && b.reportDateEnd
          && b.reportDateStart >= job.fromDate && b.reportDateEnd <= job.toDate;
        const isPortalRollup = (b.filename || "").includes("portal")
          && (b.reportDateStart !== b.reportDateEnd);
        if (overlapsWindow && isPortalRollup) {
          storage.deleteSteamSalesByBatch(b.id);
          job.batchesPurged++;
        }
      }

      // Walk day by day.
      const { fetchPortalPage, portalToSalesRows } = await import("./steamworks-portal");
      const startMs = new Date(job.fromDate + "T00:00:00Z").getTime();
      const endMs = new Date(job.toDate + "T00:00:00Z").getTime();
      const dates: string[] = [];
      for (let ms = startMs; ms <= endMs; ms += 86400000) {
        dates.push(new Date(ms).toISOString().slice(0, 10));
      }
      job.totalDays = dates.length;

      for (const dt of dates) {
        try {
          const result = await fetchPortalPage({
            appId: Number(product.steamAppId),
            dateStart: dt,
            dateEnd: dt,
            cookieHeader: session.cookieValue,
          });
          if (result.ok && result.parsed) {
            const batchId = `portal-daily-${job.productId}-${dt}`;
            // Delete any prior batch for the same date (idempotent re-runs).
            storage.deleteSteamSalesByBatch(batchId);
            const rows = portalToSalesRows(result.parsed, job.productId, dt, batchId);
            if (rows.length > 0) {
              storage.createSteamSalesUploadBatch({
                id: batchId,
                productId: job.productId,
                filename: `portal-daily-${dt}.html`,
                fileBytes: result.htmlBytes ?? 0,
                reportDateStart: dt,
                reportDateEnd: dt,
                publisherName: null,
                rowsParsed: 1,
                rowsIngested: rows.length,
                rowsSkipped: 0,
                skippedReason: null,
                uploadedBy: "portal-daily-job",
              });
              storage.upsertSteamSalesRows(rows);
            }
            job.daysSucceeded++;
          } else {
            job.daysFailed++;
            job.errors.push({ date: dt, error: (result.error ?? "unknown").slice(0, 200) });
          }
        } catch (err: any) {
          job.daysFailed++;
          job.errors.push({ date: dt, error: err?.message?.slice(0, 200) || String(err) });
        }
        job.daysProcessed++;
        await new Promise((r) => setTimeout(r, PORTAL_DAILY_DELAY_MS));
      }

      job.status = "completed";
      job.completedAt = new Date().toISOString();
      job.message = `Daily backfill: ${job.daysSucceeded}/${job.totalDays} succeeded, ${job.daysFailed} failed, ${job.batchesPurged} monthly batches purged`;
    } catch (err: any) {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      job.message = `Job crashed: ${err?.message || String(err)}`;
    }
  }

  app.post("/api/products/:id/steam/portal-daily-backfill", async (req, res) => {
    try {
      const productId = parseInt(req.params.id);
      const product = storage.getProduct(productId);
      if (!product) return res.status(404).json({ error: "Product not found" });
      if (!product.steamAppId) return res.status(400).json({ error: "Product has no steamAppId" });

      const fromDate = String(req.body?.fromDate ?? "").trim();
      const toDate = String(req.body?.toDate ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
        return res.status(400).json({ error: "fromDate and toDate required (YYYY-MM-DD)" });
      }
      if (fromDate > toDate) return res.status(400).json({ error: "fromDate must be <= toDate" });

      const job: PortalDailyJob = {
        id: makePortalDailyJobId(),
        productId,
        productTitle: product.title,
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        fromDate,
        toDate,
        totalDays: 0,
        daysProcessed: 0,
        daysSucceeded: 0,
        daysFailed: 0,
        errors: [],
        message: "Job started",
        batchesPurged: 0,
      };
      portalDailyJobs.set(job.id, job);
      // Fire and forget — the async loop runs in the Node event loop.
      runPortalDailyJob(job).catch((err) => {
        job.status = "failed";
        job.completedAt = new Date().toISOString();
        job.message = `Unhandled: ${err?.message || String(err)}`;
      });
      res.json({ jobId: job.id, status: job.status, fromDate, toDate });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/steam/portal-daily-backfill/:jobId", (req, res) => {
    const job = portalDailyJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({
      ...job,
      errors: job.errors.slice(0, 20), // trim for response size
      errorCount: job.errors.length,
    });
  });

  app.post("/api/steam/portal/monthly-run", async (req, res) => {
    try {
      const session = storage.getSteamworksSession("default");
      if (!session) return res.status(400).json({ error: "No session cookie configured" });

      // Default range: previous full month (UTC).
      const now = new Date();
      const lastDayPrev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
      const firstDayPrev = new Date(Date.UTC(lastDayPrev.getUTCFullYear(), lastDayPrev.getUTCMonth(), 1));
      const dateStart = String(req.body?.dateStart ?? firstDayPrev.toISOString().slice(0, 10));
      const dateEnd = String(req.body?.dateEnd ?? lastDayPrev.toISOString().slice(0, 10));

      const products = storage.getAllProducts().filter(p => p.steamAppId);
      const results: Array<{ productId: number; title: string; ok: boolean; rowsIngested?: number; error?: string }> = [];

      const { fetchPortalPage, portalToSalesRows } = await import("./steamworks-portal");

      for (const product of products) {
        try {
          const result = await fetchPortalPage({
            appId: Number(product.steamAppId),
            dateStart,
            dateEnd,
            cookieHeader: session.cookieValue,
          });
          if (!result.ok || !result.parsed) {
            results.push({ productId: product.id, title: product.title, ok: false, error: result.error });
            continue;
          }
          const batchId = `portal-${product.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const rows = portalToSalesRows(result.parsed, product.id, dateEnd, batchId);
          storage.createSteamSalesUploadBatch({
            id: batchId,
            productId: product.id,
            filename: `monthly-portal-${dateStart}-to-${dateEnd}.html`,
            fileBytes: result.htmlBytes ?? 0,
            reportDateStart: dateStart,
            reportDateEnd: dateEnd,
            publisherName: null,
            rowsParsed: 1,
            rowsIngested: rows.length,
            rowsSkipped: 0,
            skippedReason: null,
            uploadedBy: "monthly-cron",
          });
          if (rows.length > 0) storage.upsertSteamSalesRows(rows);
          results.push({ productId: product.id, title: product.title, ok: true, rowsIngested: rows.length });

          // Be gentle on Steamworks — sleep 2s between products.
          await new Promise(r => setTimeout(r, 2000));
        } catch (err: any) {
          results.push({ productId: product.id, title: product.title, ok: false, error: err.message });
        }
      }

      // Track overall session status
      const allFailed = results.every(r => !r.ok);
      storage.upsertSteamworksSession({
        id: "default",
        cookieValue: session.cookieValue,
        loggedInAs: session.loggedInAs,
        lastVerifiedAt: new Date().toISOString(),
        lastVerifiedResult: allFailed ? "error: all products failed" : "ok",
      });

      res.json({
        dateStart,
        dateEnd,
        productsAttempted: products.length,
        productsOk: results.filter(r => r.ok).length,
        productsFailed: results.filter(r => !r.ok).length,
        results,
      });
    } catch (err: any) {
      console.error(`[routes] monthly-run error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Undo an upload by deleting all rows it created.
  app.delete("/api/steam/sales-batch/:batchId", (req, res) => {
    try {
      const batchId = req.params.batchId;
      const batch = storage.getSteamSalesUploadBatch(batchId);
      if (!batch) return res.status(404).json({ error: "Batch not found" });
      const deleted = storage.deleteSteamSalesByBatch(batchId);
      res.json({ batchId, rowsDeleted: deleted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Daily wishlist-reporting rows (new table) with a computed running
  // cumulative per row, for optional from/to date filtering.
  app.get("/api/products/:id/steam-wishlist-daily", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;

      const rows = storage.getSteamWishlistReporting(id, from, to);

      // Running cumulative is computed fresh here (not stored) so it always
      // reflects the full history even when a `from` filter is applied —
      // we need the cumulative baseline from before `from`, if any.
      let baseline = 0;
      if (from) {
        const priorRows = storage.getSteamWishlistReporting(id).filter(r => r.date < from);
        for (const r of priorRows) {
          baseline += r.wishlistAdds - r.wishlistDeletes - r.wishlistPurchases;
        }
      }

      let running = baseline;
      const enriched = rows.map(r => {
        running += r.wishlistAdds - r.wishlistDeletes - r.wishlistPurchases;
        return {
          ...r,
          countrySummary: r.countrySummaryJson ? JSON.parse(r.countrySummaryJson) : null,
          languageSummary: r.languageSummaryJson ? JSON.parse(r.languageSummaryJson) : null,
          runningCumulative: Math.max(0, running),
        };
      });

      res.json(enriched);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── PS5 Wishlists ───────────────────────────────────────────────────────────

  app.get("/api/products/:id/ps5/wishlists", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const data = storage.getPs5Wishlists(id);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/products/:id/ps5/wishlists", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const result = storage.addPs5Wishlist({
        productId: id,
        ...req.body,
      });
      res.status(201).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── PS5 Prepurchases ────────────────────────────────────────────────────────

  app.get("/api/products/:id/ps5/prepurchases", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      // Only return data from the prepurchase start date onward
      const plsMilestones = storage.getPlsMilestones(id);
      const prepurchaseStart = plsMilestones.find(m => m.name === "Prepurchase Start");
      const prepurchaseStartDate = prepurchaseStart?.actualDate ?? null;

      if (!prepurchaseStartDate) {
        return res.json([]);
      }

      const allData = storage.getPs5Prepurchases(id);
      const filtered = allData.filter(d => d.date >= prepurchaseStartDate);
      res.json(filtered);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/products/:id/ps5/prepurchases", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      // Validate prepurchase period is active before accepting data
      const plsMilestones = storage.getPlsMilestones(id);
      const prepurchaseStart = plsMilestones.find(m => m.name === "Prepurchase Start");
      if (!prepurchaseStart?.actualDate) {
        return res.status(400).json({ error: "Cannot add pre-purchase data: the pre-purchase period has not started yet. Set an actual date on the Prepurchase Start milestone first." });
      }
      const result = storage.addPs5Prepurchase({
        productId: id,
        ...req.body,
      });
      res.status(201).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── PLS Milestones ──────────────────────────────────────────────────────────

  app.get("/api/products/:id/pls", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const milestones = storage.getPlsMilestones(id);
      res.json(milestones);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/products/:id/pls", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const milestone = storage.createPlsMilestone({
        productId: id,
        ...req.body,
        isDefault: false,
      });
      res.status(201).json(milestone);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/products/:id/pls/:milestoneId", (req, res) => {
    try {
      const milestoneId = parseInt(req.params.milestoneId);
      const updated = storage.updatePlsMilestone(milestoneId, req.body);
      if (!updated) return res.status(404).json({ error: "Milestone not found" });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/products/:id/pls/:milestoneId", (req, res) => {
    try {
      const milestoneId = parseInt(req.params.milestoneId);
      storage.deletePlsMilestone(milestoneId);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── YouTube Tracking ────────────────────────────────────────────────────────

  app.get("/api/pls/:milestoneId/youtube", (req, res) => {
    try {
      const milestoneId = parseInt(req.params.milestoneId);
      const links = storage.getYoutubeLinks(milestoneId);
      res.json(links);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/pls/:milestoneId/youtube", (req, res) => {
    try {
      const milestoneId = parseInt(req.params.milestoneId);
      const { viewCount, ...linkData } = req.body;
      const link = storage.addYoutubeLink({
        milestoneId,
        ...linkData,
      });

      // If viewCount was provided, store initial daily entry
      if (viewCount != null && viewCount > 0) {
        const today = new Date().toISOString().split("T")[0];
        storage.addYoutubeVideoDaily({
          youtubeLinkId: link.id,
          date: today,
          cumulativeViews: viewCount,
          dailyDelta: viewCount,
        });
      }

      res.status(201).json(link);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/pls/:milestoneId/youtube/:linkId", (req, res) => {
    try {
      const linkId = parseInt(req.params.linkId);
      storage.deleteYoutubeLink(linkId);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/pls/:milestoneId/youtube/:linkId/views", (req, res) => {
    try {
      const linkId = parseInt(req.params.linkId);
      const views = storage.getYoutubeViews(linkId);
      res.json(views);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Fetch video info from a YouTube URL (before saving)
  app.post("/api/pls/:milestoneId/youtube/fetch-info", async (req, res) => {
    try {
      const { youtubeUrl } = req.body;
      if (!youtubeUrl) {
        return res.status(400).json({ error: "youtubeUrl is required" });
      }

      const videoId = extractVideoId(youtubeUrl);
      if (!videoId) {
        return res.status(400).json({ error: "Could not extract a valid YouTube video ID from that URL" });
      }

      // Check if API key is configured
      const apiKeySetting = storage.getSetting("youtube_api_key");
      const apiKey = apiKeySetting?.value || undefined;

      const videoData = await fetchVideoData(videoId, apiKey);

      res.json({
        videoId: videoData.videoId,
        title: videoData.title,
        channelName: videoData.channelName,
        viewCount: videoData.viewCount,
        thumbnailUrl: videoData.thumbnailUrl,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Refresh view counts for all tracked YouTube videos (or specific milestone)
  app.post("/api/youtube/refresh-views", async (req, res) => {
    try {
      const { milestoneId } = req.body;
      const apiKeySetting = storage.getSetting("youtube_api_key");
      const apiKey = apiKeySetting?.value || undefined;

      let links;
      if (milestoneId) {
        links = storage.getYoutubeLinks(parseInt(milestoneId));
      } else {
        links = storage.getAllYoutubeLinks();
      }

      const today = new Date().toISOString().split("T")[0];
      const results: Array<{ linkId: number; videoId: string; viewCount: number | null; error?: string }> = [];

      for (const link of links) {
        try {
          const videoData = await fetchVideoData(link.youtubeVideoId, apiKey);
          
          if (videoData.viewCount != null) {
            // Get previous entry to calculate delta
            const previousViews = storage.getYoutubeViews(link.id);
            const lastEntry = previousViews.length > 0 ? previousViews[previousViews.length - 1] : null;
            const previousCumulative = lastEntry?.cumulativeViews ?? 0;
            const dailyDelta = Math.max(0, videoData.viewCount - previousCumulative);

            storage.addYoutubeVideoDaily({
              youtubeLinkId: link.id,
              date: today,
              cumulativeViews: videoData.viewCount,
              dailyDelta,
            });
          }

          results.push({
            linkId: link.id,
            videoId: link.youtubeVideoId,
            viewCount: videoData.viewCount,
          });
        } catch (err: any) {
          results.push({
            linkId: link.id,
            videoId: link.youtubeVideoId,
            viewCount: null,
            error: err.message,
          });
        }
      }

      res.json({ updated: results.length, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get aggregate YouTube views for a milestone
  app.get("/api/pls/:milestoneId/youtube/aggregate", (req, res) => {
    try {
      const milestoneId = parseInt(req.params.milestoneId);
      const aggregate = storage.getAggregateYoutubeViews(milestoneId);
      res.json(aggregate);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Steam Leaderboards ─────────────────────────────────────────────────────

  // Pre-Release Steam Wishlist Leaderboard (Phase 2). Never more than ~20
  // rows (pre-release Saber titles with a steamAppId), so all sorting
  // happens client-side against this single payload — no server pagination.
  app.get("/api/leaderboards/wishlist", (_req, res) => {
    try {
      const rows = getWishlistLeaderboardRows();
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/leaderboards/wishlist/kpis", (_req, res) => {
    try {
      const rows = getWishlistLeaderboardRows();
      const kpis = getWishlistLeaderboardKpis(rows);
      res.json(kpis);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Saber Steam Revenue Leaderboard (Phase 4). Same no-pagination convention
  // as the wishlist board — at most a handful of prepurchasing/released
  // Saber titles, so all sorting happens client-side against this payload.
  app.get("/api/leaderboards/revenue", (_req, res) => {
    try {
      const rows = getRevenueLeaderboardRows();
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/leaderboards/revenue/kpis", (_req, res) => {
    try {
      const rows = getRevenueLeaderboardRows();
      const kpis = getRevenueLeaderboardKpis(rows);
      res.json(kpis);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Weekly Digest Email Recipients (Phase 5) ────────────────────────────────
  // Managed list, not a comma-separated settings string — see
  // CLAUDE_STEAM_LEADERBOARDS.md §8.1. `email` is the only required field;
  // duplicates are rejected with a 400 (unique index on the column).

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  app.get("/api/leaderboards/email-recipients", (_req, res) => {
    try {
      const recipients = storage.getLeaderboardEmailRecipients();
      res.json(recipients);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/leaderboards/email-recipients", (req, res) => {
    try {
      const { email, label } = req.body;
      if (!email || typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
        return res.status(400).json({ error: "A valid email address is required" });
      }
      const created = storage.createLeaderboardEmailRecipient({
        email: email.trim().toLowerCase(),
        label: label?.trim() || null,
        isActive: true,
      });
      res.status(201).json(created);
    } catch (err: any) {
      if (String(err.message).includes("UNIQUE constraint failed")) {
        return res.status(400).json({ error: "That email is already on the recipient list" });
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/leaderboards/email-recipients/:id", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const body: { email?: string; label?: string | null; isActive?: boolean } = {};
      if (req.body.email !== undefined) {
        if (!EMAIL_RE.test(String(req.body.email).trim())) {
          return res.status(400).json({ error: "A valid email address is required" });
        }
        body.email = String(req.body.email).trim().toLowerCase();
      }
      if (req.body.label !== undefined) body.label = req.body.label?.trim() || null;
      if (req.body.isActive !== undefined) body.isActive = !!req.body.isActive;

      const updated = storage.updateLeaderboardEmailRecipient(id, body);
      if (!updated) return res.status(404).json({ error: "Recipient not found" });
      res.json(updated);
    } catch (err: any) {
      if (String(err.message).includes("UNIQUE constraint failed")) {
        return res.status(400).json({ error: "That email is already on the recipient list" });
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/leaderboards/email-recipients/:id", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      storage.deleteLeaderboardEmailRecipient(id);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manual "Send test digest now" trigger (Settings) — lets Phase 5 be
  // verified end-to-end without waiting for the real Monday 07:00 ET send.
  // Defaults to active recipients, same as the real weekly send, but accepts
  // an optional ?to=/body.to override (comma-separated) to target a single
  // verified test address instead — useful while resend_from is on an
  // unverified sending domain and Resend rejects sends to anyone but the
  // account owner's own email.
  app.post("/api/leaderboards/email-recipients/test-send", async (req, res) => {
    try {
      // Optional override so a test send can target a single address (e.g.
      // the Resend account owner's own inbox) instead of blasting the full
      // production distribution list — required while resend_from is on an
      // unverified sending domain, since Resend rejects sends to anyone
      // other than the account owner's email in that state.
      const toParam = (req.body?.to ?? req.query?.to) as string | undefined;
      const overrideRecipients = toParam
        ? toParam.split(",").map((e) => e.trim()).filter(Boolean)
        : undefined;
      const result = await sendWeeklyLeaderboardDigest(new Date(), overrideRecipients);
      if (!result.sent) {
        return res.status(422).json(result);
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Steam followers time series — feeds the leaderboard row's "View chart"
  // modal (ChartDetailModal dataType="steamFollowers"). Mapped to the shared
  // TimeSeriesDataPoint shape (cumulativeCount/dailyDelta) since the
  // steam_followers_daily table stores followerCount instead. Rows with a
  // null followerCount (failed-fetch marker day) are dropped rather than
  // charted as 0.
  app.get("/api/products/:id/steam/followers", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const rows = storage.getSteamFollowers(id);
      const data = rows
        .filter((r) => r.followerCount != null)
        .map((r) => ({
          date: r.date,
          cumulativeCount: r.followerCount as number,
          dailyDelta: r.dailyDelta ?? 0,
        }));
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Ingestion ──────────────────────────────────────────────────────────────

  // v1.1 (2026-07-22): wired to the real runIngestion() pipeline. Was a
  // Phase-2 stub returning 'not yet implemented' since April; runIngestion()
  // itself already persists ingestion_last_run + ingestion_last_result to
  // the settings table, so /status just reads them back.
  let ingestionInFlight = false;

  app.post("/api/ingestion/run", async (_req, res) => {
    if (ingestionInFlight) {
      return res.status(409).json({
        error: "Ingestion already in progress",
        message: "Another ingestion run is currently executing. Retry in a moment.",
      });
    }
    ingestionInFlight = true;
    try {
      const result = await runIngestion();
      res.json({
        message: "Ingestion completed",
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        totalProductsProcessed: result.totalProductsProcessed,
        totalDataPointsAdded: result.totalDataPointsAdded,
        results: result.results,
      });
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      res.status(500).json({ error: errMsg });
    } finally {
      ingestionInFlight = false;
    }
  });

  app.get("/api/ingestion/status", (_req, res) => {
    const lastRunSetting = storage.getSetting("ingestion_last_run")?.value;
    const lastResultSetting = storage.getSetting("ingestion_last_result")?.value;
    if (!lastRunSetting) {
      return res.json({
        lastRun: null,
        inFlight: ingestionInFlight,
        status: ingestionInFlight ? "running" : "never_run",
      });
    }
    let lastResult: unknown = null;
    try {
      lastResult = lastResultSetting ? JSON.parse(lastResultSetting) : null;
    } catch {
      lastResult = null;
    }
    res.json({
      lastRun: lastRunSetting,
      lastResult,
      inFlight: ingestionInFlight,
      status: ingestionInFlight ? "running" : "success",
    });
  });

  // ─── Manual Per-Source Ingestion Triggers (Settings UI buttons) ─────────────
  //
  // Three distinct auth paths behind the Wishlist + Sales Leaderboards.
  // Share the same `ingestionInFlight` guard as the full run above so a
  // manual single-source trigger can't race a full pipeline run (or another
  // single-source trigger) touching overlapping tables/settings.

  function readManualIngestionSetting(key: string) {
    const raw = storage.getSetting(key)?.value;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  app.get("/api/ingestion/manual-status", (_req, res) => {
    res.json({
      inFlight: ingestionInFlight,
      sales: readManualIngestionSetting("ingestion_last_run_sales"),
      public: readManualIngestionSetting("ingestion_last_run_public"),
      partner: readManualIngestionSetting("ingestion_last_run_partner"),
    });
  });

  app.post("/api/ingestion/run-sales", async (_req, res) => {
    if (ingestionInFlight) {
      return res.status(409).json({
        error: "Ingestion already in progress",
        message: "Another ingestion run is currently executing. Retry in a moment.",
      });
    }
    ingestionInFlight = true;
    try {
      const result = await runSalesIngestionNow();
      res.json({ message: "Sales Leaderboard ingestion completed", ...result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    } finally {
      ingestionInFlight = false;
    }
  });

  app.post("/api/ingestion/run-public-wishlist", async (_req, res) => {
    if (ingestionInFlight) {
      return res.status(409).json({
        error: "Ingestion already in progress",
        message: "Another ingestion run is currently executing. Retry in a moment.",
      });
    }
    ingestionInFlight = true;
    try {
      const result = await runPublicWishlistIngestionNow();
      res.json({ message: "Wishlist Leaderboard public-API ingestion completed", ...result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    } finally {
      ingestionInFlight = false;
    }
  });

  app.post("/api/ingestion/run-partner-wishlist", async (_req, res) => {
    if (ingestionInFlight) {
      return res.status(409).json({
        error: "Ingestion already in progress",
        message: "Another ingestion run is currently executing. Retry in a moment.",
      });
    }
    ingestionInFlight = true;
    try {
      const result = await runPartnerWishlistIngestionNow();
      res.json({ message: "Wishlist Leaderboard partner-API-key ingestion completed", ...result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    } finally {
      ingestionInFlight = false;
    }
  });

  return httpServer;
}
