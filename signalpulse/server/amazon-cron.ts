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
  AMAZON_PLATFORM_SLUGS,
  type AmazonPlatformSlug,
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
    const active = db.select().from(amazonAsinMap).where(eq(amazonAsinMap.isActive, true)).all();
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
export type AmazonJobName =
  | "charts"
  | "products"
  | "movers"
  | "keywords"
  | "new_releases"
  | "also_bought";

export async function runAmazonJob(job: AmazonJobName): Promise<unknown> {
  switch (job) {
    case "charts":       return runChartsSnapshot();
    case "products":     return runProductSnapshots();
    case "movers":       return runMoversAndNewReleases();
    case "new_releases": return runMoversAndNewReleases(); // combined job
    case "keywords":     return runKeywordSearch();
    case "also_bought":  return runAlsoBoughtWeekly();
    default:
      throw new Error(`unknown job: ${job}`);
  }
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
