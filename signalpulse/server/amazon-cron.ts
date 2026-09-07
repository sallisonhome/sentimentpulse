/**
 * Amazon Retail — in-process ingestion scheduler.
 *
 * Cadence (all America/New_York, to avoid DST drift):
 *   07:00 daily   runChartsSnapshot()       3 platforms  ~3 credits
 *   07:15 daily   runProductSnapshots()     all tracked ASINs
 *   07:30 daily   runMoversAndNewReleases() 3 platforms × 2 endpoints
 *   07:45 daily   runKeywordSearch()        7 seeded keywords
 *   08:00 Sunday  runAlsoBoughtWeekly()     all tracked ASINs, weekly refresh
 *
 * Same pattern as `leaderboard-digest.ts::startWeeklyDigestCron`: a single
 * setInterval polling every 60s and comparing wall-clock hh:mm ET against
 * each job's slot. Each job records a row in `amazon_ingest_runs` for
 * observability (Settings page / ops endpoint).
 *
 * Manual triggers live in `amazon-routes.ts` (`POST /api/amazon/ingest/run/:job`);
 * this scheduler exports the same underlying runner functions so both paths
 * share code.
 */
import { db } from "./storage";
import { storage } from "./storage";
import {
  amazonAsinMap,
  amazonChartSnapshots,
  amazonProductDaily,
  amazonMoversDaily,
  amazonNewReleases,
  amazonKeywordDaily,
  amazonAlsoBoughtDaily,
  amazonIngestRuns,
  amazonCompetitorAsinMap,
  AMAZON_PLATFORM_SLUGS,
  AMAZON_CHART_NODES,
  type AmazonPlatformSlug,
  products as productsTable,
} from "@shared/schema";
import { and, eq } from "drizzle-orm";
import {
  fetchSoftwareChart,
  fetchProduct,
  fetchMovers,
  fetchNewReleases,
  fetchSearch,
  extractAlsoBought,
  isVideoGameSoftware,
  isRainforestConfigured,
} from "./amazon-rainforest";
import { listAllCompetitorRelationships, isSentimentPulseIngestRunning } from "./sentimentpulse-client";
import { log } from "./index";

// ─── Seed keyword list ──────────────────────────────────────────────────────
// No dedicated `amazon_keywords` table yet — the brief allows a hardcoded
// seed list here as MVP. Adding a settings-driven list is a Phase 2 target
// (see routes.ts POST /api/amazon/keywords TODO).
export const AMAZON_SEED_KEYWORDS = [
  "space marine 2",
  "world war z",
  "hellraiser game",
  "silent hill townfall",
  "gears of war e-day",
  "turok",
  "snowrunner",
];

// ─── Time helpers ───────────────────────────────────────────────────────────
function getEasternHourMinuteWeekday(now: Date): { hour: number; minute: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = parseInt(get("hour"), 10) % 24; // "24" at midnight w/ hour12:false
  const minute = parseInt(get("minute"), 10);
  const weekday = get("weekday");
  return { hour, minute, weekday };
}

function todayUtcDate(): string {
  return new Date().toISOString().split("T")[0];
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Ingest-run bookkeeping ────────────────────────────────────────────────
async function withRun<T>(
  jobName: string,
  fn: () => Promise<{ result: T; creditsUsed: number; creditsRemaining: number; rowsWritten: number }>,
): Promise<T> {
  const startedAt = nowIso();
  const inserted = db.insert(amazonIngestRuns).values({
    jobName,
    startedAt,
    status: "running",
  }).returning({ id: amazonIngestRuns.id }).all();
  const runId = inserted[0]?.id;
  try {
    const { result, creditsUsed, creditsRemaining, rowsWritten } = await fn();
    if (runId != null) {
      db.update(amazonIngestRuns)
        .set({
          status: "ok",
          finishedAt: nowIso(),
          creditsUsed,
          creditsRemaining,
          rowsWritten,
        })
        .where(eq(amazonIngestRuns.id, runId))
        .run();
    }
    log(`amazon-cron ${jobName}: ok (rows=${rowsWritten} credits=${creditsUsed} remaining=${creditsRemaining})`, "amazon-cron");
    return result;
  } catch (err: any) {
    if (runId != null) {
      db.update(amazonIngestRuns)
        .set({
          status: "error",
          finishedAt: nowIso(),
          errorMessage: (err?.message ?? String(err)).slice(0, 500),
        })
        .where(eq(amazonIngestRuns.id, runId))
        .run();
    }
    log(`amazon-cron ${jobName}: ERROR ${err?.message ?? err}`, "amazon-cron");
    throw err;
  }
}

// ─── Franchise tokens (whitelist for software filter) ──────────────────────
function buildTrackedFranchiseTokens(): string[] {
  const tokens = new Set<string>();
  // From active ASIN map ↔ product titles
  const rows = db.select({
    productId: amazonAsinMap.productId,
    isActive: amazonAsinMap.isActive,
  }).from(amazonAsinMap).where(eq(amazonAsinMap.isActive, true)).all();
  const productIds = new Set(rows.map((r) => r.productId));
  const allProducts = storage.getAllProducts();
  for (const p of allProducts) {
    if (!productIds.has(p.id)) continue;
    // First 2-3 words of the title is usually the franchise token
    const words = p.title.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length > 0) tokens.add(words.slice(0, Math.min(3, words.length)).join(" "));
    if (words.length > 0) tokens.add(words[0]);
  }
  return Array.from(tokens);
}

// ─── Job: charts snapshot (07:00 daily) ────────────────────────────────────
export async function runChartsSnapshot(): Promise<{ platforms: number; rowsWritten: number }> {
  return withRun("charts", async () => {
    const franchiseTokens = buildTrackedFranchiseTokens();
    const snapshotDate = todayUtcDate();
    let totalCreditsUsed = 0;
    let lastCreditsRemaining = 0;
    let rowsWritten = 0;
    for (const platform of AMAZON_PLATFORM_SLUGS) {
      const { rows, creditsUsed, creditsRemaining } = await fetchSoftwareChart(platform, franchiseTokens, 50);
      totalCreditsUsed += creditsUsed;
      lastCreditsRemaining = creditsRemaining;
      // Wipe today's rows for this platform (idempotent re-run) then insert
      db.delete(amazonChartSnapshots)
        .where(and(eq(amazonChartSnapshots.snapshotDate, snapshotDate), eq(amazonChartSnapshots.platform, platform)))
        .run();
      for (const r of rows) {
        db.insert(amazonChartSnapshots).values({
          snapshotDate,
          platform,
          rank: r.rank,
          rawRank: r.rawRank,
          asin: r.asin,
          title: r.title,
          price: r.price,
          rating: r.rating,
          ratingsTotal: r.ratingsTotal,
          imageUrl: r.imageUrl,
          link: r.link,
          createdAt: nowIso(),
        }).run();
        rowsWritten += 1;
      }
    }
    return {
      result: { platforms: AMAZON_PLATFORM_SLUGS.length, rowsWritten },
      creditsUsed: totalCreditsUsed,
      creditsRemaining: lastCreditsRemaining,
      rowsWritten,
    };
  });
}

// ─── Job: per-ASIN product snapshot (07:15 daily) ──────────────────────────
export async function runProductSnapshots(): Promise<{ asins: number; rowsWritten: number }> {
  return withRun("products", async () => {
    const snapshotDate = todayUtcDate();
    // Fetch both Saber pins AND competitor pins; both flow into the same
    // amazon_product_daily table keyed on (snapshot_date, asin) so the same
    // downstream views (Buy Box, Reviews Pulse, BSR history) apply to both.
    const saberPins = db.select().from(amazonAsinMap).where(eq(amazonAsinMap.isActive, true)).all();
    const compPins = db.select().from(amazonCompetitorAsinMap).where(eq(amazonCompetitorAsinMap.isActive, true)).all();
    // Deduplicate on ASIN — a competitor could theoretically share an ASIN
    // with a Saber pin (edge case), but we don't want to pay Rainforest twice.
    const seenAsin = new Set<string>();
    const active: Array<{ asin: string }> = [];
    for (const p of saberPins) {
      if (seenAsin.has(p.asin)) continue;
      seenAsin.add(p.asin);
      active.push({ asin: p.asin });
    }
    for (const p of compPins) {
      if (seenAsin.has(p.asin)) continue;
      seenAsin.add(p.asin);
      active.push({ asin: p.asin });
    }
    let totalCreditsUsed = 0;
    let lastCreditsRemaining = 0;
    let rowsWritten = 0;
    for (const row of active) {
      try {
        const { data, creditsUsed, creditsRemaining } = await fetchProduct(row.asin);
        totalCreditsUsed += creditsUsed;
        lastCreditsRemaining = creditsRemaining;
        const p = data?.product ?? {};
        const buybox = p.buybox_winner ?? {};
        const price = typeof buybox.price === "number" ? buybox.price : (buybox.price?.value ?? null);
        const bsr = p.bestsellers_rank?.[0]?.rank ?? null;
        const subBsrs = (p.bestsellers_rank ?? []).slice(1).map((b: any) => ({
          category: b.category ?? null,
          rank: b.rank ?? null,
        }));
        // Upsert semantics: delete + insert
        db.delete(amazonProductDaily)
          .where(and(eq(amazonProductDaily.snapshotDate, snapshotDate), eq(amazonProductDaily.asin, row.asin)))
          .run();
        db.insert(amazonProductDaily).values({
          snapshotDate,
          asin: row.asin,
          buyboxPrice: price,
          buyboxSeller: buybox.seller ?? null,
          buyboxIsAmazon: !!(buybox.is_amazon ?? false),
          isPrime: !!(buybox.is_prime ?? p.is_prime ?? false),
          stockStatus: p.buybox_winner?.availability?.type ?? p.stock_status ?? null,
          mainBsr: bsr,
          subBsrsJson: JSON.stringify(subBsrs),
          rating: p.rating ?? null,
          ratingsTotal: p.ratings_total ?? null,
          createdAt: nowIso(),
        }).run();
        rowsWritten += 1;
      } catch (err) {
        log(`amazon-cron products: ${row.asin} failed: ${err}`, "amazon-cron");
        // continue with other ASINs
      }
    }
    return {
      result: { asins: active.length, rowsWritten },
      creditsUsed: totalCreditsUsed,
      creditsRemaining: lastCreditsRemaining,
      rowsWritten,
    };
  });
}

// ─── Job: movers + new-releases (07:30 daily) ──────────────────────────────
export async function runMoversAndNewReleases(): Promise<{ rowsWritten: number }> {
  return withRun("movers_and_new_releases", async () => {
    const franchiseTokens = buildTrackedFranchiseTokens();
    const snapshotDate = todayUtcDate();
    let totalCreditsUsed = 0;
    let lastCreditsRemaining = 0;
    let rowsWritten = 0;

    for (const platform of AMAZON_PLATFORM_SLUGS) {
      // Movers & shakers
      try {
        const m = await fetchMovers(platform);
        totalCreditsUsed += m.creditsUsed;
        lastCreditsRemaining = m.creditsRemaining;
        db.delete(amazonMoversDaily)
          .where(and(eq(amazonMoversDaily.snapshotDate, snapshotDate), eq(amazonMoversDaily.platform, platform)))
          .run();
        let rank = 0;
        for (const b of m.data?.bestsellers ?? []) {
          const title = (b.title ?? "").toString();
          if (!isVideoGameSoftware(title, franchiseTokens).keep) continue;
          rank += 1;
          db.insert(amazonMoversDaily).values({
            snapshotDate,
            platform,
            rank,
            asin: (b.asin ?? "").toString(),
            title,
            rankChange: typeof b.rank_change === "number" ? b.rank_change : (b.rank_change_pct ?? null),
            imageUrl: b.image ?? null,
            createdAt: nowIso(),
          }).run();
          rowsWritten += 1;
        }
      } catch (err) {
        log(`amazon-cron movers ${platform} failed: ${err}`, "amazon-cron");
      }

      // New releases
      try {
        const n = await fetchNewReleases(platform);
        totalCreditsUsed += n.creditsUsed;
        lastCreditsRemaining = n.creditsRemaining;
        db.delete(amazonNewReleases)
          .where(and(eq(amazonNewReleases.snapshotDate, snapshotDate), eq(amazonNewReleases.platform, platform)))
          .run();
        let rank = 0;
        for (const b of n.data?.bestsellers ?? []) {
          const title = (b.title ?? "").toString();
          if (!isVideoGameSoftware(title, franchiseTokens).keep) continue;
          rank += 1;
          db.insert(amazonNewReleases).values({
            snapshotDate,
            platform,
            rank,
            asin: (b.asin ?? "").toString(),
            title,
            firstSeenDate: null,
            imageUrl: b.image ?? null,
            createdAt: nowIso(),
          }).run();
          rowsWritten += 1;
        }
      } catch (err) {
        log(`amazon-cron new_releases ${platform} failed: ${err}`, "amazon-cron");
      }
    }

    return {
      result: { rowsWritten },
      creditsUsed: totalCreditsUsed,
      creditsRemaining: lastCreditsRemaining,
      rowsWritten,
    };
  });
}

// ─── Job: keyword search (07:45 daily) ─────────────────────────────────────
export async function runKeywordSearch(): Promise<{ rowsWritten: number }> {
  return withRun("keywords", async () => {
    const snapshotDate = todayUtcDate();
    let totalCreditsUsed = 0;
    let lastCreditsRemaining = 0;
    let rowsWritten = 0;
    for (const kw of AMAZON_SEED_KEYWORDS) {
      try {
        const s = await fetchSearch(kw);
        totalCreditsUsed += s.creditsUsed;
        lastCreditsRemaining = s.creditsRemaining;
        const raw = s.data?.search_results ?? [];
        const topN = raw.slice(0, 20).map((r: any, idx: number) => ({
          rank: idx + 1,
          asin: r.asin ?? null,
          title: r.title ?? null,
          isSponsored: !!(r.sponsored ?? false),
          price: typeof r.price === "number" ? r.price : (r.price?.value ?? null),
          imageUrl: r.image ?? null,
        }));
        db.delete(amazonKeywordDaily)
          .where(and(eq(amazonKeywordDaily.snapshotDate, snapshotDate), eq(amazonKeywordDaily.keyword, kw)))
          .run();
        db.insert(amazonKeywordDaily).values({
          snapshotDate,
          keyword: kw,
          resultsJson: JSON.stringify(topN),
          createdAt: nowIso(),
        }).run();
        rowsWritten += 1;
      } catch (err) {
        log(`amazon-cron keywords ${kw} failed: ${err}`, "amazon-cron");
      }
    }
    return {
      result: { rowsWritten },
      creditsUsed: totalCreditsUsed,
      creditsRemaining: lastCreditsRemaining,
      rowsWritten,
    };
  });
}

// ─── Job: also-bought weekly (08:00 Sunday) ────────────────────────────────
export async function runAlsoBoughtWeekly(): Promise<{ sources: number; rowsWritten: number }> {
  return withRun("also_bought", async () => {
    const snapshotDate = todayUtcDate();
    const active = db.select().from(amazonAsinMap).where(eq(amazonAsinMap.isActive, true)).all();
    let totalCreditsUsed = 0;
    let lastCreditsRemaining = 0;
    let rowsWritten = 0;
    for (const src of active) {
      try {
        const { data, creditsUsed, creditsRemaining } = await fetchProduct(src.asin);
        totalCreditsUsed += creditsUsed;
        lastCreditsRemaining = creditsRemaining;
        const alsoBought = extractAlsoBought(data, 5);
        db.delete(amazonAlsoBoughtDaily)
          .where(and(eq(amazonAlsoBoughtDaily.snapshotDate, snapshotDate), eq(amazonAlsoBoughtDaily.sourceAsin, src.asin)))
          .run();
        for (const ab of alsoBought) {
          db.insert(amazonAlsoBoughtDaily).values({
            snapshotDate,
            sourceAsin: src.asin,
            rankPosition: ab.rankPosition,
            recommendedAsin: ab.recommendedAsin,
            title: ab.title,
            price: ab.price,
            rating: ab.rating,
            ratingsTotal: ab.ratingsTotal,
            mainBsr: null,
            imageUrl: ab.imageUrl,
            link: ab.link,
            createdAt: nowIso(),
          }).run();
          rowsWritten += 1;
        }
      } catch (err) {
        log(`amazon-cron also_bought ${src.asin} failed: ${err}`, "amazon-cron");
      }
    }
    return {
      result: { sources: active.length, rowsWritten },
      creditsUsed: totalCreditsUsed,
      creditsRemaining: lastCreditsRemaining,
      rowsWritten,
    };
  });
}

// ─── Manual job dispatch (used by /api/amazon/ingest/run/:job) ─────────────
// ─── Job: ASIN auto-discovery (on-demand) ────────────────────────────────
// Match SignalPulse-tracked product titles against recent chart snapshots
// to auto-populate amazon_asin_map (isAuto=true) so the daily products +
// weekly also_bought jobs have ASINs to fetch. Zero Rainforest credits
// consumed (pure DB join). Idempotent: only inserts asin_map rows that
// don't already exist for a given (product_id, platform).
//
// Match algorithm:
//   1. Normalize product title + all Rainforest chart titles (lowercase,
//      strip trademark/edition suffixes, remove punctuation).
//   2. For each product-title-word set W_p and chart-title-word set W_c:
//      score = |W_p ∩ W_c| / |W_p| (recall against product title).
//   3. Accept the highest-scoring chart row per platform above threshold
//      (default 0.6). Store the score in match_score for audit.
export async function runAsinDiscovery(threshold = 0.6): Promise<{
  productsScanned: number;
  candidatesConsidered: number;
  mappingsInserted: number;
  mappingsSkipped: number;
}> {
  return withRun("asin_discovery", async () => {
    // Read every product in SignalPulse.
    const products = storage.getAllProducts();
    // Read the last 3 days of chart snapshots to have a robust match pool.
    const recentCharts = db.select().from(amazonChartSnapshots).all();
    // Existing pins so we don't clobber a manual override.
    const existingPins = db.select().from(amazonAsinMap).all();
    const pinKey = (pid: number, plat: string) => `${pid}|${plat}`;
    const existingByKey = new Set(existingPins.map((p) => pinKey(p.productId, p.platform)));

    // Pre-normalize chart rows keyed by platform.
    const chartsByPlatform = new Map<string, Array<{ asin: string; words: Set<string>; title: string }>>();
    for (const plat of AMAZON_PLATFORM_SLUGS) chartsByPlatform.set(plat, []);
    for (const row of recentCharts) {
      const list = chartsByPlatform.get(row.platform);
      if (!list) continue;
      list.push({ asin: row.asin, words: normalizeWords(row.title), title: row.title });
    }

    let candidatesConsidered = 0;
    let mappingsInserted = 0;
    let mappingsSkipped = 0;
    const now = nowIso();

    // Cross-platform ASIN reuse guard (same as search variant).
    const usedAsinsPerProduct = new Map<number, Set<string>>();
    for (const existing of existingPins) {
      if (!usedAsinsPerProduct.has(existing.productId)) usedAsinsPerProduct.set(existing.productId, new Set());
      usedAsinsPerProduct.get(existing.productId)!.add(existing.asin);
    }

    for (const p of products) {
      const pWords = normalizeWords(p.title);
      if (pWords.size === 0) continue;
      // Product.platforms filter (same as search variant).
      const productPlats: string[] = (() => {
        try { const arr = JSON.parse(p.platforms ?? "[]"); return Array.isArray(arr) ? arr : []; } catch { return []; }
      })();
      const wantsPs5 = productPlats.some((x) => /ps5|playstation\s*5/i.test(x));
      const wantsXbox = productPlats.some((x) => /xbox/i.test(x));
      const wantsSwitch = productPlats.some((x) => /switch/i.test(x));
      const platWanted: Record<string, boolean> = { ps5: wantsPs5, xbox: wantsXbox, switch: wantsSwitch };

      for (const plat of AMAZON_PLATFORM_SLUGS) {
        if (!platWanted[plat]) continue;
        // Skip if we already have a pin (manual or auto) for this product+platform.
        if (existingByKey.has(pinKey(p.id, plat))) {
          mappingsSkipped += 1;
          continue;
        }
        const candidates = chartsByPlatform.get(plat) ?? [];
        candidatesConsidered += candidates.length;
        const usedForThisProduct = usedAsinsPerProduct.get(p.id) ?? new Set<string>();
        let best: { asin: string; score: number; title: string; isSwitch2: boolean } | null = null;
        for (const c of candidates) {
          if (c.words.size === 0) continue;
          // Platform keyword must appear in the chart title.
          const platCheck = titleMentionsPlatform(c.title, plat);
          if (!platCheck.ok) continue;
          if (usedForThisProduct.has(c.asin)) continue;
          if (isAsinAncientForProduct(c.asin, p.releaseDate ?? null)) continue;
          const overlap = countIntersection(pWords, c.words);
          const score = overlap / pWords.size;
          if (score >= threshold && (best == null || score > best.score)) {
            best = { asin: c.asin, score, title: c.title, isSwitch2: platCheck.isSwitch2 };
          }
        }
        if (best) {
          db.insert(amazonAsinMap).values({
            productId: p.id,
            platform: plat,
            asin: best.asin,
            isAuto: true,
            isActive: true,
            isSwitch2: best.isSwitch2,
            matchScore: best.score,
            discoveredAt: now,
            updatedAt: now,
          }).run();
          existingByKey.add(pinKey(p.id, plat));
          if (!usedAsinsPerProduct.has(p.id)) usedAsinsPerProduct.set(p.id, new Set());
          usedAsinsPerProduct.get(p.id)!.add(best.asin);
          mappingsInserted += 1;
          log(`asin-discovery matched product #${p.id} "${p.title}" → ${plat}${best.isSwitch2 ? " 2" : ""} ${best.asin} (${best.title}) score=${best.score.toFixed(2)}`, "amazon-cron");
        }
      }
    }

    return {
      result: { productsScanned: products.length, candidatesConsidered, mappingsInserted, mappingsSkipped },
      creditsUsed: 0,
      creditsRemaining: 0, // no Rainforest call
      rowsWritten: mappingsInserted,
    };
  });
}

// ─── Job: search-based ASIN discovery (on-demand) ────────────────────
// Same intent as runAsinDiscovery but expands the candidate pool from
// "today's top-50 chart snapshot" to "Rainforest search results within the
// platform's game category". Catches Saber titles that are on Amazon but
// ranked below #50 (e.g. Rideshare, SnowRunner, World War Z between spikes).
//
// Costs ~1 Rainforest credit per (product × platform) query. Idempotent:
// skips (product_id, platform) pairs that already have any pin. Best result
// per platform above `threshold` wins; match_score persisted for audit.
export async function runAsinSearchDiscovery(threshold = 0.6): Promise<{
  productsScanned: number;
  queriesIssued: number;
  mappingsInserted: number;
  mappingsSkipped: number;
  noMatch: number;
}> {
  return withRun("asin_search_discovery", async () => {
    const products = storage.getAllProducts();
    const existingPins = db.select().from(amazonAsinMap).all();
    const pinKey = (pid: number, plat: string) => `${pid}|${plat}`;
    const existingByKey = new Set(existingPins.map((p) => pinKey(p.productId, p.platform)));

    let queriesIssued = 0;
    let mappingsInserted = 0;
    let mappingsSkipped = 0;
    let noMatch = 0;
    let totalCreditsUsed = 0;
    let lastCreditsRemaining = 0;
    const now = nowIso();

    // No-cross-platform-reuse guard: once we pin ASIN X to product P on
    // platform PS5, we refuse to also pin X to P on Xbox or Switch. One Amazon
    // ASIN is one SKU on one platform — the auto-discovery kept violating
    // this because the search API returns the same top result across nodes.
    const usedAsinsPerProduct = new Map<number, Set<string>>();
    for (const existing of existingPins) {
      if (!usedAsinsPerProduct.has(existing.productId)) usedAsinsPerProduct.set(existing.productId, new Set());
      usedAsinsPerProduct.get(existing.productId)!.add(existing.asin);
    }

    for (const p of products) {
      const pWords = normalizeWords(p.title);
      if (pWords.size === 0) continue;
      // Only run discovery for platforms this product actually lists in
      // SignalPulse — no more "assign a Switch pin to a title that isn't on
      // Switch just because Amazon has a Switch bundle listing that matches
      // the words." Product.platforms is a JSON array like
      // ["PC (Steam)", "PS5", "Xbox", "Switch 2"].
      const productPlats: string[] = (() => {
        try { const arr = JSON.parse(p.platforms ?? "[]"); return Array.isArray(arr) ? arr : []; } catch { return []; }
      })();
      const wantsPs5 = productPlats.some((x) => /ps5|playstation\s*5/i.test(x));
      const wantsXbox = productPlats.some((x) => /xbox/i.test(x));
      const wantsSwitch = productPlats.some((x) => /switch/i.test(x)); // covers both Switch and Switch 2
      const platWanted: Record<string, boolean> = { ps5: wantsPs5, xbox: wantsXbox, switch: wantsSwitch };

      for (const plat of AMAZON_PLATFORM_SLUGS) {
        if (!platWanted[plat]) continue;
        if (existingByKey.has(pinKey(p.id, plat))) {
          mappingsSkipped += 1;
          continue;
        }
        const node = AMAZON_CHART_NODES[plat];
        try {
          const usedForThisProduct = usedAsinsPerProduct.get(p.id) ?? new Set<string>();

          // Score up to `sliceN` raw results against the standard filter chain
          // (isVideoGameSoftware → titleMentionsPlatform → not-already-pinned
          // → not-ancient → word-overlap ≥ threshold) and return the best
          // accepted candidate.
          const scoreResults = (results: any[], sliceN: number): { asin: string; score: number; title: string; isSwitch2: boolean } | null => {
            let best: { asin: string; score: number; title: string; isSwitch2: boolean } | null = null;
            for (const r of results.slice(0, sliceN)) {
              const asin = (r.asin ?? "").toString();
              const title = (r.title ?? "").toString();
              if (!asin || !title) continue;
              if (!isVideoGameSoftware(title).keep) continue;
              const platCheck = titleMentionsPlatform(title, plat);
              if (!platCheck.ok) continue;
              if (usedForThisProduct.has(asin)) continue;
              if (isAsinAncientForProduct(asin, p.releaseDate ?? null)) continue;
              const rWords = normalizeWords(title);
              if (rWords.size === 0) continue;
              const overlap = countIntersection(pWords, rWords);
              const score = overlap / pWords.size;
              if (score >= threshold && (best == null || score > best.score)) {
                best = { asin, score, title, isSwitch2: platCheck.isSwitch2 };
              }
            }
            return best;
          };

          // Pass 1 — search inside the platform bestsellers category node.
          // Cheap and works for established titles that are already on the
          // chart. Top-5 is enough since the category already filters noise.
          const pass1 = await fetchSearch(p.title, node.nodeId);
          queriesIssued += 1;
          totalCreditsUsed += pass1.creditsUsed;
          lastCreditsRemaining = pass1.creditsRemaining;
          const results1: any[] = pass1.data?.search_results ?? [];
          let best = scoreResults(results1, 5);
          let matchSource: "category" | "unscoped" | "unscoped+platform" = "category";
          let unscopedRawCount = 0;

          // Pass 2 — retry without the category filter when pass 1 turned up
          // no platform-matched result. Rainforest's category_id points to
          // the *bestsellers* node (e.g. 20972781011 = PS5 Games Best-Sellers),
          // which excludes pre-orders and brand-new titles with no sales
          // history. Without category we may see books/comics/movies too, but
          // isVideoGameSoftware + titleMentionsPlatform already reject those,
          // so this is safe. Costs +1 Rainforest search credit only when
          // pass 1 fails. Scan top-10 to give the real SKU a chance to appear
          // past any mixed-media results.
          if (best == null) {
            const pass2 = await fetchSearch(p.title);
            queriesIssued += 1;
            totalCreditsUsed += pass2.creditsUsed;
            lastCreditsRemaining = pass2.creditsRemaining;
            const results2: any[] = pass2.data?.search_results ?? [];
            unscopedRawCount = results2.length;
            best = scoreResults(results2, 10);
            if (best != null) matchSource = "unscoped";
          }

          // Pass 3 — append platform hint words to the keyword. Franchise
          // titles that are also books/comics/movies (Hellraiser, Halloween,
          // John Wick, Turok, Jurassic Park, etc.) have Amazon search results
          // dominated by non-game media even when unscoped, so the real game
          // SKU is buried too deep to appear in top-10. Adding "PS5" /
          // "Xbox Series X" / "Nintendo Switch" to the query shifts Amazon's
          // relevance toward the game listing. Same downstream filter chain
          // still gates results. Costs +1 credit only when passes 1+2 fail.
          if (best == null) {
            const platHint = plat === "ps5" ? "PS5"
              : plat === "xbox" ? "Xbox Series X"
              : "Nintendo Switch";
            const pass3 = await fetchSearch(`${p.title} ${platHint}`);
            queriesIssued += 1;
            totalCreditsUsed += pass3.creditsUsed;
            lastCreditsRemaining = pass3.creditsRemaining;
            const results3: any[] = pass3.data?.search_results ?? [];
            best = scoreResults(results3, 10);
            if (best != null) matchSource = "unscoped+platform";
          }

          if (best) {
            db.insert(amazonAsinMap).values({
              productId: p.id,
              platform: plat,
              asin: best.asin,
              isAuto: true,
              isActive: true,
              isSwitch2: best.isSwitch2,
              matchScore: best.score,
              discoveredAt: now,
              updatedAt: now,
            }).run();
            existingByKey.add(pinKey(p.id, plat));
            if (!usedAsinsPerProduct.has(p.id)) usedAsinsPerProduct.set(p.id, new Set());
            usedAsinsPerProduct.get(p.id)!.add(best.asin);
            mappingsInserted += 1;
            log(`asin-search-discovery matched product #${p.id} "${p.title}" → ${plat}${best.isSwitch2 ? " 2" : ""} ${best.asin} (${best.title}) score=${best.score.toFixed(2)} via=${matchSource}`, "amazon-cron");
          } else {
            noMatch += 1;
            log(`asin-search-discovery no match: product #${p.id} "${p.title}" on ${plat} (${results1.length} category / ${unscopedRawCount} unscoped raw results, +platform fallback also failed)`, "amazon-cron");
          }
        } catch (err) {
          log(`asin-search-discovery: product #${p.id} on ${plat} failed: ${err}`, "amazon-cron");
        }
      }
    }

    return {
      result: { productsScanned: products.length, queriesIssued, mappingsInserted, mappingsSkipped, noMatch },
      creditsUsed: totalCreditsUsed,
      creditsRemaining: lastCreditsRemaining,
      rowsWritten: mappingsInserted,
    };
  });
}

// Normalize a title into a token set for word-overlap scoring.
// Strips edition/format words that add no signal (edition, deluxe, remaster,
// etc.) and platform words we don't want inflating overlap (PS5, Xbox,
// Nintendo, Switch, physical). Keeps franchise/subtitle words.
const DISCOVERY_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "on", "in", "with",
  "edition", "deluxe", "standard", "collector", "collectors", "physical",
  "digital", "complete", "definitive", "goty", "remaster", "remastered",
  "gold", "premium", "ultimate", "anniversary", "game", "video", "videogame",
  "ps5", "ps4", "playstation", "xbox", "series", "x", "s", "nintendo",
  "switch", "2", "one", "pc", "amazon",
]);

export function normalizeWords(title: string): Set<string> {
  const cleaned = title
    .toLowerCase()
    .replace(/[\u00AE\u2122\u00A9]/g, "") // ® ™ ©
    .replace(/[^a-z0-9\s]/g, " ") // punctuation -> space
    .replace(/\s+/g, " ")
    .trim();
  const out = new Set<string>();
  for (const w of cleaned.split(" ")) {
    if (w.length < 2) continue;
    if (DISCOVERY_STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

export function countIntersection(a: Set<string>, b: Set<string>): number {
  let n = 0;
  a.forEach((w) => { if (b.has(w)) n += 1; });
  return n;
}

// Platform keyword gate: reject a candidate ASIN unless its Amazon listing
// title actually mentions the target platform. Without this the search
// discovery happily picks up cross-platform listings from an adjacent
// browse-node leak (e.g. matching an old PS3 SKU to a PS5 pin because the
// title words overlap), which is the exact failure mode that produced the
// wrong Road Kings / Tempest Rising pins.
export function titleMentionsPlatform(title: string, plat: string): { ok: boolean; isSwitch2: boolean } {
  const t = title.toLowerCase();
  if (plat === "ps5") {
    // Accept PS5 / PlayStation 5. Reject bare "playstation" so PS3/PS4 don't slip through.
    return { ok: /\bps5\b|\bplaystation\s*5\b/.test(t), isSwitch2: false };
  }
  if (plat === "xbox") {
    // Accept Xbox Series X|S. Reject bare Xbox 360 / Xbox One.
    return { ok: /\bxbox\s*series\b|\bxbox\s*x\s*\|\s*s\b|\bxbox\b(?!\s*(360|one))/.test(t), isSwitch2: false };
  }
  if (plat === "switch") {
    const isSwitch2 = /\bswitch\s*2\b|\bnintendo\s*switch\s*2\b/.test(t);
    // Accept any Nintendo Switch or Switch 2 title.
    const ok = /\bnintendo\s*switch\b|\bswitch\b/.test(t);
    return { ok, isSwitch2 };
  }
  return { ok: false, isSwitch2: false };
}

// Release-year floor: if a candidate Amazon listing was published far before
// the SignalPulse product's release date, it can't be the SKU we want. We
// don't have the Amazon publish year in search results by default, so use
// the ASIN prefix as a coarse epoch signal (ASINs are lexically ordered by
// registration date within Amazon's catalog). Cheap heuristic: block clearly
// ancient ASINs (B0007*, B0016*, B001A*, B0075*, B008K*, B0068*) for
// products released in 2020 or later. This kills the 2007-era Road Kings
// (B00079HZX4) / Tempest Rising (B001AZRJGM) matches without needing extra
// Rainforest calls. When product.releaseDate isn't set we skip the check.
export function isAsinAncientForProduct(asin: string, productReleaseDate: string | null | undefined): boolean {
  if (!productReleaseDate) return false;
  const year = Number(productReleaseDate.slice(0, 4));
  if (!Number.isFinite(year) || year < 2020) return false;
  // ASIN prefixes B0000–B008ZZ correspond roughly to 2000–2012 registrations.
  // Modern SKUs (2020+) start at B08* and later.
  const prefix = asin.slice(0, 3).toUpperCase();
  const legacyPrefixes = ["B00", "B01", "B02", "B03", "B04", "B05", "B06", "B07"];
  if (legacyPrefixes.includes(prefix)) {
    // Prefix B08–B0D are 2020–2025+. Anything B00–B07 is likely too old for
    // a post-2020 product SKU. Not perfect — remasters can reuse old ASINs
    // — but the manual editor is the escape hatch for those.
    return true;
  }
  return false;
}

// ─── Job: competitor ASIN discovery (daily) ───────────────────────────
// Pulls the parent ↔ competitor relationships from SentimentPulse
// (games/{parent_id}/competitors), joins parents to SignalPulse products by
// steam_app_id, then Rainforest-search-discovers ASINs for every competitor
// on every platform. Idempotent per (sentimentpulse_game_id, platform) so
// running daily is safe.
//
// Costs ~1 Rainforest credit per unmapped (competitor × platform) query.
// Every competitor pin discovered here feeds into the daily products job
// automatically (runProductSnapshots reads both amazon_asin_map AND
// amazon_competitor_asin_map).
export async function runCompetitorDiscovery(threshold = 0.6): Promise<{
  parentsWithComps: number;
  competitorsScanned: number;
  queriesIssued: number;
  mappingsInserted: number;
  mappingsSkipped: number;
  parentsMissingProductRow: number;
  noMatch: number;
  deferred?: string | undefined;
}> {
  return withRun("competitor_discovery", async () => {
    // SAFETY: don't call SentimentPulse while its own daily ingest is running.
    // SP ingest at 06:45 ET is heavy on the shared Postgres pool and network
    // I/O; piling 20-40 GETs on top has historically wedged it (main.py:118
    // lessons). Skip cleanly and let the next scheduled tick pick it up.
    if (await isSentimentPulseIngestRunning()) {
      log("competitor-discovery: SentimentPulse ingest is currently running — deferring to next scheduled slot", "amazon-cron");
      return {
        result: {
          parentsWithComps: 0,
          competitorsScanned: 0,
          queriesIssued: 0,
          mappingsInserted: 0,
          mappingsSkipped: 0,
          parentsMissingProductRow: 0,
          noMatch: 0,
          deferred: "sentimentpulse_ingest_running" as string | undefined,
        },
        creditsUsed: 0,
        creditsRemaining: 0,
        rowsWritten: 0,
      };
    }
    // Get every parent↔competitor relationship from SentimentPulse. This
    // performs 1 + N HTTP calls (list games, then competitors per game) on
    // the loopback, so it is intentionally lightweight.
    const relationships = await listAllCompetitorRelationships();
    // Group by parent steam_app_id so we can resolve each parent to a
    // SignalPulse product once.
    const parentSteamIds = new Set(relationships.map((r) => r.parentSteamAppId.toString()));
    // Look up SignalPulse products by steam_app_id in one pass.
    const allProducts = db.select().from(productsTable).all();
    const productBySteamId = new Map<string, typeof allProducts[number]>();
    for (const p of allProducts) {
      if (p.steamAppId) productBySteamId.set(p.steamAppId, p);
    }

    // Existing competitor pins to skip.
    const existingPins = db.select().from(amazonCompetitorAsinMap).all();
    const pinKey = (gameId: number, plat: string) => `${gameId}|${plat}`;
    const existingByKey = new Set(existingPins.map((p) => pinKey(p.sentimentpulseGameId, p.platform)));

    let queriesIssued = 0;
    let mappingsInserted = 0;
    let mappingsSkipped = 0;
    let noMatch = 0;
    let parentsMissingProductRow = 0;
    let totalCreditsUsed = 0;
    let lastCreditsRemaining = 0;
    const now = nowIso();

    // Track which parents have at least one SignalPulse product row for reporting.
    const parentsWithProduct = new Set<number>();
    for (const steamId of Array.from(parentSteamIds)) {
      if (!productBySteamId.has(steamId)) {
        parentsMissingProductRow += 1;
        log(`competitor-discovery: parent steam_app_id ${steamId} has no SignalPulse product row — skipping its competitors`, "amazon-cron");
      } else {
        parentsWithProduct.add(productBySteamId.get(steamId)!.id);
      }
    }

    for (const rel of relationships) {
      const parentProduct = productBySteamId.get(rel.parentSteamAppId.toString());
      if (!parentProduct) continue; // logged above
      const compName = rel.competitor.name;
      const compWords = normalizeWords(compName);
      if (compWords.size === 0) continue;

      // Cross-platform reuse guard — same principle as the Saber path.
      const usedForThisComp = new Set<string>(
        existingPins.filter((x) => x.sentimentpulseGameId === rel.competitor.id).map((x) => x.asin),
      );

      for (const plat of AMAZON_PLATFORM_SLUGS) {
        if (existingByKey.has(pinKey(rel.competitor.id, plat))) {
          mappingsSkipped += 1;
          continue;
        }
        const node = AMAZON_CHART_NODES[plat];
        try {
          const { data, creditsUsed, creditsRemaining } = await fetchSearch(compName, node.nodeId);
          queriesIssued += 1;
          totalCreditsUsed += creditsUsed;
          lastCreditsRemaining = creditsRemaining;
          const results: any[] = data?.search_results ?? [];
          let best: { asin: string; score: number; title: string } | null = null;
          for (const r of results.slice(0, 5)) {
            const asin = (r.asin ?? "").toString();
            const title = (r.title ?? "").toString();
            if (!asin || !title) continue;
            if (!isVideoGameSoftware(title)) continue;
            // Platform keyword must appear in Amazon title.
            if (!titleMentionsPlatform(title, plat).ok) continue;
            // No cross-platform ASIN reuse for the same competitor.
            if (usedForThisComp.has(asin)) continue;
            const rWords = normalizeWords(title);
            if (rWords.size === 0) continue;
            const overlap = countIntersection(compWords, rWords);
            const score = overlap / compWords.size;
            if (score >= threshold && (best == null || score > best.score)) {
              best = { asin, score, title };
            }
          }
          if (best) {
            db.insert(amazonCompetitorAsinMap).values({
              sentimentpulseGameId: rel.competitor.id,
              parentProductId: parentProduct.id,
              name: compName,
              steamAppId: rel.competitor.steam_app_id,
              platform: plat,
              asin: best.asin,
              isAuto: true,
              isActive: true,
              matchScore: best.score,
              discoveredAt: now,
              updatedAt: now,
            }).run();
            existingByKey.add(pinKey(rel.competitor.id, plat));
            usedForThisComp.add(best.asin);
            mappingsInserted += 1;
            log(`competitor-discovery matched "${compName}" (under "${parentProduct.title}") → ${plat} ${best.asin} score=${best.score.toFixed(2)}`, "amazon-cron");
          } else {
            noMatch += 1;
          }
        } catch (err) {
          log(`competitor-discovery: "${compName}" on ${plat} failed: ${err}`, "amazon-cron");
        }
      }
    }

    // Dedupe count of competitors + parents for the summary.
    const uniqueParents = new Set(relationships.map((r) => r.parentGameId));
    const uniqueCompetitors = new Set(relationships.map((r) => r.competitor.id));

    return {
      result: {
        parentsWithComps: uniqueParents.size,
        competitorsScanned: uniqueCompetitors.size,
        queriesIssued,
        mappingsInserted,
        mappingsSkipped,
        parentsMissingProductRow,
        noMatch,
        deferred: undefined as string | undefined,
      },
      creditsUsed: totalCreditsUsed,
      creditsRemaining: lastCreditsRemaining,
      rowsWritten: mappingsInserted,
    };
  });
}

export type AmazonJobName =
  | "charts"
  | "products"
  | "movers"
  | "keywords"
  | "new_releases"
  | "also_bought"
  | "asin_discovery"
  | "asin_search_discovery"
  | "competitor_discovery"
  | "clean_auto_pins";

export async function runAmazonJob(job: AmazonJobName): Promise<unknown> {
  switch (job) {
    case "charts":                return runChartsSnapshot();
    case "products":              return runProductSnapshots();
    case "movers":                return runMoversAndNewReleases();
    case "new_releases":          return runMoversAndNewReleases(); // combined job
    case "keywords":              return runKeywordSearch();
    case "also_bought":           return runAlsoBoughtWeekly();
    case "asin_discovery":        return runAsinDiscovery();
    case "asin_search_discovery": return runAsinSearchDiscovery();
    case "competitor_discovery": return runCompetitorDiscovery();
    case "clean_auto_pins":      return runCleanAutoPins();
    default:
      throw new Error(`unknown job: ${job}`);
  }
}

// Wipe every auto-discovered pin (Saber + competitor). Manual pins kept.
// Same effect as POST /api/amazon/asin-map/auto-clear, but reachable through
// the ingest ops-token path so we can invoke it from the ingest-trigger
// workflow without needing a saber JWT.
async function runCleanAutoPins(): Promise<unknown> {
  return withRun("clean_auto_pins", async () => {
    const before = db.select().from(amazonAsinMap).where(eq(amazonAsinMap.isAuto, true)).all();
    db.delete(amazonAsinMap).where(eq(amazonAsinMap.isAuto, true)).run();
    const compBefore = db.select().from(amazonCompetitorAsinMap).where(eq(amazonCompetitorAsinMap.isAuto, true)).all();
    db.delete(amazonCompetitorAsinMap).where(eq(amazonCompetitorAsinMap.isAuto, true)).run();
    return {
      result: {
        deletedSaberPins: before.length,
        deletedCompetitorPins: compBefore.length,
      },
      creditsUsed: 0,
      creditsRemaining: 0,
      rowsWritten: before.length + compBefore.length,
    };
  });
}

// ─── Scheduler ─────────────────────────────────────────────────────────────
let amazonCronInterval: ReturnType<typeof setInterval> | null = null;
const lastRunPerSlot: Record<string, string> = {}; // slotKey → yyyy-mm-dd

function shouldRunSlot(slotKey: string, todayStr: string): boolean {
  if (lastRunPerSlot[slotKey] === todayStr) return false;
  lastRunPerSlot[slotKey] = todayStr;
  return true;
}

export function startAmazonIngestionCron(): void {
  if (amazonCronInterval) return; // idempotent
  log("Amazon Retail ingestion cron scheduler started (America/New_York)", "amazon-cron");

  amazonCronInterval = setInterval(() => {
    if (!isRainforestConfigured()) return; // silently no-op until key is set
    const now = new Date();
    const { hour, minute, weekday } = getEasternHourMinuteWeekday(now);
    const todayStr = now.toISOString().split("T")[0];

    // 5-minute grace windows (matches leaderboard-digest pattern to survive
    // setInterval tick drift under load).
    const inWindow = (targetH: number, targetM: number) =>
      hour === targetH && minute >= targetM && minute <= targetM + 5;

    // 04:00 ET — competitor discovery. Deliberately scheduled well BEFORE
    // the SentimentPulse daily ingest (06:45 ET / 10:45 UTC) so we never
    // share the SP DB pool / network window with SP's own long-running
    // Reddit + Steam ingest. Also runs before the Amazon charts (07:00 ET)
    // and products (07:15 ET) slots so any newly-added competitor gets an
    // ASIN pin the same day it's added, ready for the products snapshot.
    // Extra defense: the job itself checks GET /api/ingest/status and
    // defers if SP ingest is running.
    if (inWindow(4, 0) && shouldRunSlot("competitor_discovery", todayStr)) {
      runCompetitorDiscovery().catch((err) => log(`amazon-cron competitor_discovery failed: ${err}`, "amazon-cron"));
    }
    if (inWindow(7, 0) && shouldRunSlot("charts", todayStr)) {
      runChartsSnapshot().catch((err) => log(`amazon-cron charts failed: ${err}`, "amazon-cron"));
    }
    if (inWindow(7, 15) && shouldRunSlot("products", todayStr)) {
      runProductSnapshots().catch((err) => log(`amazon-cron products failed: ${err}`, "amazon-cron"));
    }
    if (inWindow(7, 30) && shouldRunSlot("movers_and_new_releases", todayStr)) {
      runMoversAndNewReleases().catch((err) => log(`amazon-cron movers_and_new_releases failed: ${err}`, "amazon-cron"));
    }
    if (inWindow(7, 45) && shouldRunSlot("keywords", todayStr)) {
      runKeywordSearch().catch((err) => log(`amazon-cron keywords failed: ${err}`, "amazon-cron"));
    }
    if (weekday === "Sun" && inWindow(8, 0) && shouldRunSlot("also_bought", todayStr)) {
      runAlsoBoughtWeekly().catch((err) => log(`amazon-cron also_bought failed: ${err}`, "amazon-cron"));
    }
  }, 60_000);
}

export function stopAmazonIngestionCron(): void {
  if (amazonCronInterval) {
    clearInterval(amazonCronInterval);
    amazonCronInterval = null;
    log("Amazon Retail ingestion cron scheduler stopped", "amazon-cron");
  }
}

// (AmazonPlatformSlug is imported for type parity with amazon-rainforest.ts;
// callers may not reference it directly from this file.)
export type { AmazonPlatformSlug };
