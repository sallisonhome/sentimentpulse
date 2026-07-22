/**
 * Daily Ingestion Engine
 * 
 * Runs on a cron schedule (default: 2:00 AM UTC daily).
 * Checks for API keys in Settings — if a key exists, fetches data from that source.
 * If a key is missing, skips that source gracefully.
 * YouTube view counts are always refreshed (public method works without API key).
 */

import { storage } from "./storage";
import { fetchVideoData, fetchViewCountPublic } from "./youtube-fetcher";
import { calculateDynamicForecasts } from "./forecast";
import { log } from "./index";

// ─── Types ───────────────────────────────────────────────────────────────────

interface IngestionResult {
  source: string;
  status: "success" | "skipped" | "error";
  message: string;
  productsProcessed?: number;
  dataPointsAdded?: number;
}

interface IngestionRunResult {
  startedAt: string;
  completedAt: string;
  results: IngestionResult[];
  totalProductsProcessed: number;
  totalDataPointsAdded: number;
}

// ─── Steam Ingestion ─────────────────────────────────────────────────────────

async function ingestSteamData(apiKey: string, partnerId: string): Promise<IngestionResult> {
  const products = storage.getAllProducts();
  const saberProducts = products.filter(p => p.isSaberPublished && p.steamAppId);
  
  if (saberProducts.length === 0) {
    return { source: "steam", status: "skipped", message: "No Saber-published titles with Steam App IDs" };
  }

  const today = new Date().toISOString().split("T")[0];
  let dataPoints = 0;
  // v1.2 (2026-07-22): surface Steam API failures per product so users
  // can diagnose 'ingestion ran but 0 data points added' -- e.g. wrong
  // key scope, app not associated with partner, or Steam server error.
  const productErrors: Array<{ productId: number; title: string; error: string }> = [];

  for (const product of saberProducts) {
    try {
      // Steamworks Partner API: ISteamUserStats/GetAppWishlistReporting
      // Requires a Publisher-level Web API key (partner.steamgames.com)
      // and the app must be associated with that partner account.
      const wishlistUrl = `https://partner.steam-api.com/ISteamUserStats/GetAppWishlistReporting/v1/?key=${apiKey}&appid=${product.steamAppId}`;

      const wlResponse = await fetch(wishlistUrl);
      if (!wlResponse.ok) {
        // Read the response body for diagnosis. Steam typically returns a
        // plain-text error or a very small JSON error blob on 4xx.
        const bodyText = await wlResponse.text().catch(() => "");
        const errSummary = `HTTP ${wlResponse.status} — ${bodyText.slice(0, 200)}`;
        productErrors.push({ productId: product.id, title: product.title, error: `wishlist: ${errSummary}` });
        log(`Steam wishlist ${errSummary} for ${product.title} (appid=${product.steamAppId})`, "ingestion");
      } else {
        const wlData = await wlResponse.json();
        // Extract the latest wishlist count from the response
        const totalWishlists = wlData?.response?.total_wishlists;
        if (totalWishlists != null) {
          const latest = storage.getLatestSteamWishlist(product.id);
          const prevCount = latest?.cumulativeCount ?? 0;
          const delta = totalWishlists - prevCount;

          storage.addSteamWishlist({
            productId: product.id,
            date: today,
            cumulativeCount: totalWishlists,
            dailyDelta: Math.max(0, delta),
            source: "api",
          });
          dataPoints++;
        } else {
          // 200 OK but no total_wishlists field — unusual, capture the shape
          productErrors.push({
            productId: product.id,
            title: product.title,
            error: `wishlist: 200 OK but no response.total_wishlists field. Body: ${JSON.stringify(wlData).slice(0, 200)}`,
          });
          log(`Steam wishlist 200 OK but empty for ${product.title}`, "ingestion");
        }
      }

      // Steam prepurchase data — only ingest if prepurchase period has started
      // Check the Prepurchase Start milestone for an actual date
      const plsMilestones = storage.getPlsMilestones(product.id);
      const prepurchaseStart = plsMilestones.find(m => m.name === "Prepurchase Start");
      const prepurchaseActive = !!prepurchaseStart?.actualDate;

      if (prepurchaseActive) {
        const prepurchaseUrl = `https://partner.steam-api.com/ISteamUserStats/GetAppPrepurchaseReporting/v1/?key=${apiKey}&appid=${product.steamAppId}`;
        
        const preResponse = await fetch(prepurchaseUrl);
        if (preResponse.ok) {
          const preData = await preResponse.json();
          const totalPrepurchases = preData?.response?.total_prepurchases;
          if (totalPrepurchases != null) {
            const latest = storage.getLatestSteamPrepurchase(product.id);
            const prevCount = latest?.cumulativeCount ?? 0;
            const delta = totalPrepurchases - prevCount;
            
            storage.addSteamPrepurchase({
              productId: product.id,
              date: today,
              cumulativeCount: totalPrepurchases,
              dailyDelta: Math.max(0, delta),
              source: "api",
            });
            dataPoints++;
          }
        }
      } else {
        log(`Steam prepurchase skipped for ${product.title}: prepurchase period not started`, "ingestion");
      }
    } catch (err) {
      log(`Steam ingestion error for ${product.title}: ${err}`, "ingestion");
    }
  }

  // Include the per-product errors in the message so users can see why
  // ingestion ran but added zero data points (most common cause: partner
  // key scope / app-not-in-account).
  const errorSummary = productErrors.length > 0
    ? ` — ${productErrors.length} error${productErrors.length === 1 ? "" : "s"}: ${productErrors.map(e => `[${e.title}] ${e.error}`).join("; ")}`
    : "";

  return {
    source: "steam",
    status: productErrors.length > 0 && dataPoints === 0 ? "error" : "success",
    message: `Processed ${saberProducts.length} Saber-published Steam titles${errorSummary}`,
    productsProcessed: saberProducts.length,
    dataPointsAdded: dataPoints,
  };
}

// ─── Sony / PlayStation Ingestion ────────────────────────────────────────────

async function ingestSonyData(apiKey: string, partnerId: string): Promise<IngestionResult> {
  const products = storage.getAllProducts();
  const saberProducts = products.filter(p => {
    const platforms = JSON.parse(p.platforms);
    return p.isSaberPublished && platforms.includes("PS5");
  });
  
  if (saberProducts.length === 0) {
    return { source: "sony", status: "skipped", message: "No Saber-published titles with PS5 platform" };
  }

  const today = new Date().toISOString().split("T")[0];
  let dataPoints = 0;

  for (const product of saberProducts) {
    try {
      // Sony Partner Portal API
      // Note: Sony's analytics are typically accessed via their Domo-powered partner portal
      // The exact API endpoint structure will depend on Saber's partner integration
      const sonyApiBase = "https://analytics.playstation.net/api/v1";
      
      // Wishlist counts
      const wlResponse = await fetch(`${sonyApiBase}/titles/${product.steamAppId}/wishlists`, {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "X-Partner-ID": partnerId,
        },
      });
      
      if (wlResponse.ok) {
        const wlData = await wlResponse.json();
        const totalWishlists = wlData?.total_wishlists;
        if (totalWishlists != null) {
          const latest = storage.getLatestPs5Wishlist(product.id);
          const prevCount = latest?.cumulativeCount ?? 0;
          const delta = totalWishlists - prevCount;
          
          storage.addPs5Wishlist({
            productId: product.id,
            date: today,
            cumulativeCount: totalWishlists,
            dailyDelta: Math.max(0, delta),
            source: "api",
          });
          dataPoints++;
        }
      }

      // Prepurchase counts — only ingest if prepurchase period has started
      const plsMilestones = storage.getPlsMilestones(product.id);
      const prepurchaseStart = plsMilestones.find(m => m.name === "Prepurchase Start");
      const prepurchaseActive = !!prepurchaseStart?.actualDate;

      if (prepurchaseActive) {
        const preResponse = await fetch(`${sonyApiBase}/titles/${product.steamAppId}/prepurchases`, {
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "X-Partner-ID": partnerId,
          },
        });
        
        if (preResponse.ok) {
          const preData = await preResponse.json();
          const totalPrepurchases = preData?.total_prepurchases;
          if (totalPrepurchases != null) {
            const latest = storage.getLatestPs5Prepurchase(product.id);
            const prevCount = latest?.cumulativeCount ?? 0;
            const delta = totalPrepurchases - prevCount;
            
            storage.addPs5Prepurchase({
              productId: product.id,
              date: today,
              cumulativeCount: totalPrepurchases,
              dailyDelta: Math.max(0, delta),
              source: "api",
            });
            dataPoints++;
          }
        }
      } else {
        log(`Sony prepurchase skipped for ${product.title}: prepurchase period not started`, "ingestion");
      }
    } catch (err) {
      log(`Sony ingestion error for ${product.title}: ${err}`, "ingestion");
    }
  }

  return {
    source: "sony",
    status: "success",
    message: `Processed ${saberProducts.length} Saber-published PS5 titles`,
    productsProcessed: saberProducts.length,
    dataPointsAdded: dataPoints,
  };
}

// ─── YouTube Ingestion ───────────────────────────────────────────────────────

async function ingestYouTubeData(apiKey?: string): Promise<IngestionResult> {
  const allLinks = storage.getAllYoutubeLinks();
  
  if (allLinks.length === 0) {
    return { source: "youtube", status: "skipped", message: "No YouTube videos being tracked" };
  }

  const today = new Date().toISOString().split("T")[0];
  let dataPoints = 0;
  let errors = 0;

  for (const link of allLinks) {
    try {
      let viewCount: number | null = null;

      if (apiKey && apiKey.trim().length > 0) {
        // Use API if available
        try {
          const data = await fetchVideoData(link.youtubeVideoId, apiKey);
          viewCount = data.viewCount;
        } catch {
          // Fall back to public fetch
          viewCount = await fetchViewCountPublic(link.youtubeVideoId);
        }
      } else {
        // Public fetch only
        viewCount = await fetchViewCountPublic(link.youtubeVideoId);
      }

      if (viewCount != null) {
        // Get previous day's count to calculate delta
        const existingViews = storage.getYoutubeViews(link.id);
        const lastEntry = existingViews.length > 0 ? existingViews[existingViews.length - 1] : null;
        const prevCount = lastEntry?.cumulativeViews ?? 0;
        const delta = Math.max(0, viewCount - prevCount);

        storage.addYoutubeVideoDaily({
          youtubeLinkId: link.id,
          date: today,
          cumulativeViews: viewCount,
          dailyDelta: delta,
        });
        dataPoints++;
      }
    } catch (err) {
      errors++;
      log(`YouTube ingestion error for video ${link.youtubeVideoId}: ${err}`, "ingestion");
    }

    // Small delay to avoid rate limiting (especially for public page fetches)
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  const method = apiKey ? "API + public fallback" : "public (no API key)";
  return {
    source: "youtube",
    status: errors > 0 && dataPoints === 0 ? "error" : "success",
    message: `Refreshed ${dataPoints}/${allLinks.length} videos via ${method}${errors > 0 ? ` (${errors} errors)` : ""}`,
    productsProcessed: allLinks.length,
    dataPointsAdded: dataPoints,
  };
}

// ─── Dynamic Forecast Recalculation ──────────────────────────────────────────

function recalculateForecasts(): IngestionResult {
  const products = storage.getAllProducts();
  const today = new Date().toISOString().split("T")[0];
  let updated = 0;

  for (const product of products) {
    try {
      const platforms = JSON.parse(product.platforms);
      const latestSteamWl = storage.getLatestSteamWishlist(product.id);
      const latestPs5Pre = storage.getLatestPs5Prepurchase(product.id);

      if (latestSteamWl || latestPs5Pre) {
        const forecasts = calculateDynamicForecasts(
          platforms,
          latestSteamWl?.cumulativeCount ?? null,
          latestPs5Pre?.cumulativeCount ?? null,
        );

        const forecastRows = forecasts.map(f => ({
          productId: product.id,
          date: today,
          platform: f.platform,
          forecastUnits: f.forecastUnits,
          steamWishlistCountUsed: latestSteamWl?.cumulativeCount ?? null,
          ps5PrepurchaseCountUsed: latestPs5Pre?.cumulativeCount ?? null,
        }));

        storage.upsertDynamicForecasts(forecastRows);
        updated++;
      }
    } catch (err) {
      log(`Forecast recalculation error for product ${product.id}: ${err}`, "ingestion");
    }
  }

  return {
    source: "forecasts",
    status: "success",
    message: `Recalculated dynamic forecasts for ${updated} products`,
    productsProcessed: updated,
    dataPointsAdded: updated,
  };
}

// ─── Main Ingestion Runner ───────────────────────────────────────────────────

export async function runIngestion(): Promise<IngestionRunResult> {
  const startedAt = new Date().toISOString();
  const results: IngestionResult[] = [];

  log("Starting daily ingestion run...", "ingestion");

  // 1. Check API keys
  const steamApiKey = storage.getSetting("steam_api_key")?.value;
  const steamPartnerId = storage.getSetting("steam_partner_id")?.value;
  const sonyApiKey = storage.getSetting("sony_api_key")?.value;
  const sonyPartnerId = storage.getSetting("sony_partner_id")?.value;
  const youtubeApiKey = storage.getSetting("youtube_api_key")?.value;

  // 2. Steam ingestion
  if (steamApiKey && steamApiKey.trim().length > 0) {
    log("Steam API key found — ingesting Steam data...", "ingestion");
    const steamResult = await ingestSteamData(steamApiKey, steamPartnerId || "");
    results.push(steamResult);
    log(`Steam: ${steamResult.message}`, "ingestion");
  } else {
    results.push({ source: "steam", status: "skipped", message: "No Steam API key configured" });
    log("Steam: skipped (no API key)", "ingestion");
  }

  // 3. Sony ingestion
  if (sonyApiKey && sonyApiKey.trim().length > 0) {
    log("Sony API key found — ingesting PS5 data...", "ingestion");
    const sonyResult = await ingestSonyData(sonyApiKey, sonyPartnerId || "");
    results.push(sonyResult);
    log(`Sony: ${sonyResult.message}`, "ingestion");
  } else {
    results.push({ source: "sony", status: "skipped", message: "No Sony API key configured" });
    log("Sony: skipped (no API key)", "ingestion");
  }

  // 4. YouTube ingestion (always runs — works without API key)
  log("Refreshing YouTube view counts...", "ingestion");
  const ytResult = await ingestYouTubeData(youtubeApiKey || undefined);
  results.push(ytResult);
  log(`YouTube: ${ytResult.message}`, "ingestion");

  // 5. Recalculate dynamic forecasts
  log("Recalculating dynamic forecasts...", "ingestion");
  const forecastResult = recalculateForecasts();
  results.push(forecastResult);
  log(`Forecasts: ${forecastResult.message}`, "ingestion");

  const completedAt = new Date().toISOString();
  const totalProductsProcessed = results.reduce((sum, r) => sum + (r.productsProcessed || 0), 0);
  const totalDataPointsAdded = results.reduce((sum, r) => sum + (r.dataPointsAdded || 0), 0);

  // Save the run result to the database
  storage.upsertSetting("ingestion_last_run", completedAt);
  storage.upsertSetting("ingestion_last_result", JSON.stringify({
    startedAt,
    completedAt,
    results,
    totalProductsProcessed,
    totalDataPointsAdded,
  }));

  log(`Ingestion complete. ${totalDataPointsAdded} data points added across ${totalProductsProcessed} items.`, "ingestion");

  return {
    startedAt,
    completedAt,
    results,
    totalProductsProcessed,
    totalDataPointsAdded,
  };
}

// ─── Cron Scheduler ──────────────────────────────────────────────────────────

let cronInterval: ReturnType<typeof setInterval> | null = null;

export function startIngestionCron(): void {
  // Run daily at 2:00 AM UTC
  // We use setInterval with 1-minute checks to hit the target time
  const TARGET_HOUR = 2;
  const TARGET_MINUTE = 0;
  let lastRunDate = "";

  log("Ingestion cron scheduler started (daily at 02:00 UTC)", "ingestion");

  cronInterval = setInterval(() => {
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    
    if (
      now.getUTCHours() === TARGET_HOUR &&
      now.getUTCMinutes() === TARGET_MINUTE &&
      lastRunDate !== todayStr
    ) {
      lastRunDate = todayStr;
      runIngestion().catch(err => {
        log(`Ingestion cron error: ${err}`, "ingestion");
      });
    }
  }, 60_000); // Check every minute
}

export function stopIngestionCron(): void {
  if (cronInterval) {
    clearInterval(cronInterval);
    cronInterval = null;
    log("Ingestion cron scheduler stopped", "ingestion");
  }
}
