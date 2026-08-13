/**
 * Steam Leaderboards — data assembly for the Pre-Release Steam Wishlist
 * Leaderboard (Phase 2). See CLAUDE_STEAM_LEADERBOARDS.md §5/§6.2.
 *
 * Scope matches the ingestion functions in ingestion.ts: pre-release
 * (releaseDate null or in the future) Saber-published titles with a
 * steamAppId. There will never be more than ~20 rows, so all aggregation
 * happens in JS against already-fetched rows — no need for SQL-side
 * pagination or windowing.
 */

import { storage } from "./storage";
import { getYesterdayGmtDateString } from "./ingestion";

function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function getPreReleaseSaberSteamTitles() {
  const today = getTodayDateString();
  return storage.getAllProducts().filter(
    (p) => p.isSaberPublished && p.steamAppId && (!p.releaseDate || p.releaseDate > today),
  );
}

export interface WishlistLeaderboardRow {
  productId: number;
  title: string;
  steamAppId: string;
  headerImage: string;
  wishlistTotal: number | null;
  wishlistDelta1d: number | null;
  followersTotal: number | null;
  followersDelta1d: number | null;
  rankCurrent: number | null;
  rankDelta7d: number | null;
  igdbHype: number | null;
}

/**
 * v3.14 (2026-08-12): headerImage now prefers the REAL URL cached from
 * Steam's appdetails API (products.steam_header_image_url, populated by
 * ingestHeaderImages in ingestion.ts) and only falls back to the
 * synthesized Cloudflare CDN path when nothing has been cached yet (e.g.
 * a brand-new title before its first ingestion run). The synthesized path
 * 404s for titles Steam has moved to hashed Akamai asset paths — that's
 * exactly the bug this cache fixes for Rideshare Stimulator and Jurassic
 * Park: Survival. The client's <img onError> fallback (leaderboards.tsx)
 * still stays as a last-resort safety net either way.
 */
function synthesizeHeaderImage(steamAppId: string): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/header.jpg`;
}

function resolveHeaderImage(steamAppId: string, cachedUrl: string | null): string {
  return cachedUrl ?? synthesizeHeaderImage(steamAppId);
}

export function getWishlistLeaderboardRows(): WishlistLeaderboardRow[] {
  const titles = getPreReleaseSaberSteamTitles();

  return titles.map((p) => {
    const wishlistSummary = storage.getSteamWishlistSummary(p.id, p.releaseDate ?? null);
    const followersLatest = storage.getLatestSteamFollowers(p.id);
    const rankLatest = storage.getLatestSteamWishlistRank(p.id);
    const rank7dAgo = storage.getSteamWishlistRankDaysAgo(p.id, 7);
    const igdbLatest = storage.getLatestIgdbHype(p.id);

    const rankCurrent = rankLatest?.rank ?? null;
    const rankPast = rank7dAgo?.rank ?? null;
    // Rank is 1-based, lower = better. A positive delta means the title
    // climbed (past rank number was higher/worse than current) — matches
    // the "positive = improvement" convention used for wishlist/follower
    // deltas so the UI can apply a single green-up/red-down rule everywhere.
    const rankDelta7d = rankCurrent != null && rankPast != null ? rankPast - rankCurrent : null;

    return {
      productId: p.id,
      title: p.title,
      steamAppId: p.steamAppId!,
      headerImage: resolveHeaderImage(p.steamAppId!, p.steamHeaderImageUrl ?? null),
      wishlistTotal: wishlistSummary.lifetimeNet,
      wishlistDelta1d: wishlistSummary.dayOverDayDelta,
      followersTotal: followersLatest?.followerCount ?? null,
      followersDelta1d: followersLatest?.dailyDelta ?? null,
      rankCurrent,
      rankDelta7d,
      igdbHype: igdbLatest?.hypeScore ?? null,
    };
  });
}

export interface LeaderboardMover {
  productId: number;
  title: string;
  headerImage: string;
  delta: number;
  direction: "up" | "down";
}

function pickBiggestMover(
  rows: WishlistLeaderboardRow[],
  deltaKey: "wishlistDelta1d" | "followersDelta1d" | "rankDelta7d",
): LeaderboardMover | null {
  let best: LeaderboardMover | null = null;
  for (const row of rows) {
    const delta = row[deltaKey];
    if (delta == null || delta === 0) continue;
    if (best == null || Math.abs(delta) > Math.abs(best.delta)) {
      best = {
        productId: row.productId,
        title: row.title,
        headerImage: row.headerImage,
        delta,
        direction: delta > 0 ? "up" : "down",
      };
    }
  }
  return best;
}

export interface WishlistLeaderboardKpis {
  biggest24hWishlistMover: LeaderboardMover | null;
  biggest7dRankMover: LeaderboardMover | null;
  biggest24hFollowerMover: LeaderboardMover | null;
}

export function getWishlistLeaderboardKpis(rows: WishlistLeaderboardRow[]): WishlistLeaderboardKpis {
  return {
    biggest24hWishlistMover: pickBiggestMover(rows, "wishlistDelta1d"),
    biggest7dRankMover: pickBiggestMover(rows, "rankDelta7d"),
    biggest24hFollowerMover: pickBiggestMover(rows, "followersDelta1d"),
  };
}

// ─── Revenue Leaderboard (Phase 4) ──────────────────────────────────────────

function dayOffsetDateString(baseDate: string, offsetDays: number): string {
  const d = new Date(`${baseDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Revenue-Leaderboard eligibility mirrors ingestSteamSales() in
 * ingestion.ts (steamAppId set AND (Prepurchase Start milestone fired OR
 * released)) but is not imported from there — ingestion.ts's copy is
 * private (cron-internal) and this one serves read-only API requests, same
 * duplication convention already used for getPreReleaseSaberSteamTitles().
 *
 * v3.17: dropped the isSaberPublished filter so Focus-published titles
 * with real Steam sales (Space Marine 2, Tempest Rising, World War Z,
 * John Carpenter's Toxic Commando) also appear on this board — keep this
 * in sync with ingestion.ts's copy of the same filter.
 */
function getRevenueEligibleSteamTitles() {
  const today = getTodayDateString();
  return storage.getAllProducts().filter((p) => {
    if (!p.steamAppId) return false;
    const milestones = storage.getPlsMilestones(p.id);
    const prepurchaseActive = !!milestones.find((m) => m.name === "Prepurchase Start")?.actualDate;
    const releaseDate = storage.getProductReleaseDate(p.id);
    const released = !!releaseDate && releaseDate <= today;
    return prepurchaseActive || released;
  });
}

export interface RevenueLeaderboardRow {
  productId: number;
  title: string;
  steamAppId: string;
  headerImage: string;
  units24h: number | null;
  unitsDeltaPct24h: number | null;
  revenue24hUsd: number | null;
  revenueDeltaPct24h: number | null;
  dlcUnits24h: number | null;
  dlcRevenue24h: number | null;
  ltdRevenueUsd: number | null;
  revenue30d: number | null;
  revenueDelta30dUsd: number | null;
  revenueDelta30dPct: number | null;
}

/**
 * Percent change helper with explicit "no baseline" semantics —
 * portalToSalesRows() never writes a zero-sales row (v3.x convention: a
 * day with 0 units for a SKU group simply has no row), so an absent prior
 * value is a real 0, not missing data. A 0 -> N change is reported as
 * `null` (rendered "—"/"new" by the client) rather than Infinity/NaN,
 * since "+∞%" is meaningless to show in a table cell.
 */
function pctChange(current: number, prior: number): number | null {
  if (prior === 0) return current === 0 ? 0 : null;
  return Math.round(((current - prior) / prior) * 1000) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function getRevenueLeaderboardRows(): RevenueLeaderboardRow[] {
  const titles = getRevenueEligibleSteamTitles();
  // Anchor every row to the same "yesterday" the cron ingests into, so the
  // board never shows blanks around midnight UTC while today's row is
  // still pending its nightly fetch.
  const yesterday = getYesterdayGmtDateString();
  const dayBefore = dayOffsetDateString(yesterday, -1);
  const trailing30Start = dayOffsetDateString(yesterday, -29); // 30 days incl. yesterday
  const prior30Start = dayOffsetDateString(yesterday, -59);
  const prior30End = dayOffsetDateString(yesterday, -30);

  return titles.map((p) => {
    const allRows = storage.getSteamSales(p.id);
    const summary = storage.getSteamSalesSummary(p.id);

    // Absent-row-means-zero: default every bucket to 0, then accumulate
    // whatever rows exist. Never treat a missing row as null/unknown —
    // only the final delta computation distinguishes "no baseline" (null)
    // from "confirmed zero" (0).
    let baseUnitsYesterday = 0;
    let baseRevYesterday = 0;
    let baseUnitsDayBefore = 0;
    let baseRevDayBefore = 0;
    let dlcUnitsYesterday = 0;
    let dlcRevYesterday = 0;
    let revenue30d = 0;
    let revenuePrior30d = 0;
    let any30dRow = false;
    let anyPrior30dRow = false;

    for (const r of allRows) {
      if (r.skuGroup !== "base" && r.skuGroup !== "dlc") continue; // exclude 'other' per plan §1.4 revenue rule

      if (r.date === yesterday) {
        if (r.skuGroup === "base") {
          baseUnitsYesterday += r.netUnits;
          baseRevYesterday += r.netRevenueUsd;
        } else {
          dlcUnitsYesterday += r.netUnits;
          dlcRevYesterday += r.netRevenueUsd;
        }
      }
      if (r.date === dayBefore && r.skuGroup === "base") {
        baseUnitsDayBefore += r.netUnits;
        baseRevDayBefore += r.netRevenueUsd;
      }
      if (r.date >= trailing30Start && r.date <= yesterday) {
        revenue30d += r.netRevenueUsd;
        any30dRow = true;
      }
      if (r.date >= prior30Start && r.date <= prior30End) {
        revenuePrior30d += r.netRevenueUsd;
        anyPrior30dRow = true;
      }
    }

    const ltdRevenueUsd = round2(summary.baseNetRevenueUsd + summary.dlcNetRevenueUsd);
    // No sales history at all yet (brand-new prepurchase title) -> render
    // "—" everywhere rather than a confident "$0.00", matching §6.4.
    const hasAnyHistory = summary.rowCount > 0;

    return {
      productId: p.id,
      title: p.title,
      steamAppId: p.steamAppId!,
      headerImage: resolveHeaderImage(p.steamAppId!, p.steamHeaderImageUrl ?? null),
      units24h: hasAnyHistory ? baseUnitsYesterday : null,
      unitsDeltaPct24h: hasAnyHistory ? pctChange(baseUnitsYesterday, baseUnitsDayBefore) : null,
      revenue24hUsd: hasAnyHistory ? round2(baseRevYesterday) : null,
      revenueDeltaPct24h: hasAnyHistory ? pctChange(baseRevYesterday, baseRevDayBefore) : null,
      dlcUnits24h: hasAnyHistory ? dlcUnitsYesterday : null,
      dlcRevenue24h: hasAnyHistory ? round2(dlcRevYesterday) : null,
      ltdRevenueUsd: hasAnyHistory ? ltdRevenueUsd : null,
      revenue30d: any30dRow ? round2(revenue30d) : hasAnyHistory ? 0 : null,
      revenueDelta30dUsd: any30dRow || anyPrior30dRow ? round2(revenue30d - revenuePrior30d) : null,
      revenueDelta30dPct: any30dRow || anyPrior30dRow ? pctChange(revenue30d, revenuePrior30d) : null,
    };
  });
}

export interface RevenueLeaderboardMover {
  productId: number;
  title: string;
  headerImage: string;
  delta: number;
  direction: "up" | "down";
  /** true when this mover's metric is a % figure rather than a raw count/$ */
  isPercent?: boolean;
}

function pickBiggestRevenueMover(
  rows: RevenueLeaderboardRow[],
  deltaKey: "units24h" | "revenue24hUsd" | "revenueDelta30dPct",
  compareAgainst?: "unitsDeltaPct24h" | "revenueDeltaPct24h",
): RevenueLeaderboardMover | null {
  let best: RevenueLeaderboardMover | null = null;
  for (const row of rows) {
    // For raw 24h counts we rank by the day's absolute value (a title
    // selling 500 units yesterday is "the mover" even with no prior-day
    // baseline to diff against); for the 30-day % lift we rank by the
    // delta itself, which is already relative.
    const raw = deltaKey === "units24h" ? row.units24h
      : deltaKey === "revenue24hUsd" ? row.revenue24hUsd
      : row.revenueDelta30dPct;
    if (raw == null || raw === 0) continue;
    if (best == null || Math.abs(raw) > Math.abs(best.delta)) {
      best = {
        productId: row.productId,
        title: row.title,
        headerImage: row.headerImage,
        delta: raw,
        direction: raw > 0 ? "up" : "down",
        isPercent: deltaKey === "revenueDelta30dPct",
      };
    }
  }
  return best;
}

export interface RevenueLeaderboardKpis {
  biggest24hUnitsMover: RevenueLeaderboardMover | null;
  biggest24hRevenueMover: RevenueLeaderboardMover | null;
  biggest30dRevenueLift: RevenueLeaderboardMover | null;
}

export function getRevenueLeaderboardKpis(rows: RevenueLeaderboardRow[]): RevenueLeaderboardKpis {
  return {
    biggest24hUnitsMover: pickBiggestRevenueMover(rows, "units24h"),
    biggest24hRevenueMover: pickBiggestRevenueMover(rows, "revenue24hUsd"),
    biggest30dRevenueLift: pickBiggestRevenueMover(rows, "revenueDelta30dPct"),
  };
}
