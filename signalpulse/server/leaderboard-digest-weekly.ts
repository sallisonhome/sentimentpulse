/**
 * Weekly aggregation + hold/release gating for the Weekly Steam Leaderboard
 * Digest (v4.0, 2026-08-14).
 *
 * Prior to this version the digest rendered LIVE point-in-time leaderboard
 * state (24h/7d deltas) via leaderboards.ts. Per user direction, the digest
 * must instead summarize the PRIOR Mon-Sun week: total wishlist adds, total
 * follower adds, rank movement (Sunday vs prior Sunday), and total revenue
 * per title per SKU category (base game vs DLC).
 *
 * This module owns:
 *   1. Week-window math (Mon-Sun, anchored to America/New_York calendar days
 *      to match the existing Monday 07:00 ET send cadence).
 *   2. Weekly data assembly — reuses the SAME title lists (pre-release Saber
 *      wishlist titles / revenue-eligible titles) as leaderboards.ts so the
 *      digest's title set never drifts from the live /leaderboards UI.
 *   3. Sales-gap detection + hold-state persistence, per the user's rule:
 *      "if there isn't a full week's data because a session went stale via
 *      steam cookie we pause the digest being sent until the missing day is
 *      filled in ... then compile and send."
 *
 * Gap detection is intentionally scoped to SALES data only (not
 * wishlist/follower/rank) — those are separate, non-cookie-gated pipelines
 * (public Steam endpoints), and their null/missing conventions already mean
 * "fetch failed that day" or "outside top-200", not "ingestion never ran".
 * Gating the send on those too would hold the digest for reasons unrelated
 * to the user's stated cookie-expiry concern.
 */
import { storage } from "./storage";
import { getPreReleaseSaberSteamTitles, getRevenueEligibleSteamTitles } from "./leaderboards";

// ─── Week window ─────────────────────────────────────────────────────────

export interface WeekWindow {
  weekStart: string; // YYYY-MM-DD, Monday
  weekEnd: string; // YYYY-MM-DD, Sunday
}

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The prior Mon-Sun week ending the Sunday before `now`, using
 * America/New_York calendar days — same anchor as the Monday 07:00 ET send
 * cadence and the pre-existing formatWeekLabel() in leaderboard-digest.ts
 * (which now delegates here so both stay in sync).
 */
export function getWeekWindow(now: Date = new Date()): WeekWindow {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dow = et.getDay(); // 0=Sun..6=Sat
  const daysSinceSunday = dow === 0 ? 7 : dow;
  const weekEnd = new Date(et);
  weekEnd.setDate(et.getDate() - daysSinceSunday);
  const weekStart = new Date(weekEnd);
  weekStart.setDate(weekEnd.getDate() - 6);
  return { weekStart: toDateStr(weekStart), weekEnd: toDateStr(weekEnd) };
}

function enumerateDates(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(`${start}T00:00:00.000Z`);
  const endD = new Date(`${end}T00:00:00.000Z`);
  while (cur <= endD) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function dayBefore(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ─── Weekly Wishlist Leaderboard data ───────────────────────────────────────

export interface WeeklyWishlistRow {
  productId: number;
  title: string;
  steamAppId: string;
  headerImage: string;
  wishlistTotal: number | null; // lifetime net, for context
  weeklyWishlistAdds: number | null; // sum(adds - deletes) over the week; null = no reporting rows in window
  followersTotal: number | null;
  weeklyFollowerAdds: number | null; // sum(dailyDelta), nulls skipped; null = no rows in window at all
  rankSunday: number | null; // rank on the week's closing Sunday; null = unranked (outside top-200) or no data
  rankPriorSunday: number | null;
  rankDelta: number | null; // pastRank - currentRank; positive = climbed = green (see project convention)
  igdbHype: number | null;
}

function synthesizeHeaderImage(steamAppId: string): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/header.jpg`;
}

function resolveHeaderImage(steamAppId: string, cachedUrl: string | null): string {
  return cachedUrl ?? synthesizeHeaderImage(steamAppId);
}

/** Rank row whose date is <= targetDate, closest to it (handles a day where
 * the rank scan didn't run / title was mid-onboarding). Returns null if no
 * row exists on or before targetDate within the given rows array. */
function rankOnOrBefore(rows: { date: string; rank: number | null }[], targetDate: string): number | null {
  let best: { date: string; rank: number | null } | null = null;
  for (const r of rows) {
    if (r.date > targetDate) continue;
    if (best == null || r.date > best.date) best = r;
  }
  return best?.rank ?? null;
}

export function getWeeklyWishlistRows(window: WeekWindow): WeeklyWishlistRow[] {
  const titles = getPreReleaseSaberSteamTitles();
  const rankLookbackStart = dayBefore(window.weekStart); // need prior-Sunday rank too

  return titles.map((p) => {
    const wishlistSummary = storage.getSteamWishlistSummary(p.id, p.releaseDate ?? null);
    const followersLatest = storage.getLatestSteamFollowers(p.id);

    const reportingRows = storage.getSteamWishlistReporting(p.id, window.weekStart, window.weekEnd);
    const weeklyWishlistAdds = reportingRows.length > 0
      ? reportingRows.reduce((sum, r) => sum + (r.wishlistAdds - r.wishlistDeletes), 0)
      : null;

    const followerRows = storage.getSteamFollowers(p.id)
      .filter((r) => r.date >= window.weekStart && r.date <= window.weekEnd);
    const followerRowsWithDelta = followerRows.filter((r) => r.dailyDelta != null);
    const weeklyFollowerAdds = followerRowsWithDelta.length > 0
      ? followerRowsWithDelta.reduce((sum, r) => sum + (r.dailyDelta as number), 0)
      : (followerRows.length > 0 ? 0 : null);

    const allRankRows = storage.getSteamWishlistRanks(p.id)
      .filter((r) => r.date >= rankLookbackStart && r.date <= window.weekEnd);
    const rankSunday = rankOnOrBefore(allRankRows, window.weekEnd);
    const rankPriorSunday = rankOnOrBefore(allRankRows, rankLookbackStart);
    const rankDelta = rankSunday != null && rankPriorSunday != null ? rankPriorSunday - rankSunday : null;

    const igdbLatest = storage.getLatestIgdbHype(p.id);

    return {
      productId: p.id,
      title: p.title,
      steamAppId: p.steamAppId!,
      headerImage: resolveHeaderImage(p.steamAppId!, p.steamHeaderImageUrl ?? null),
      wishlistTotal: wishlistSummary.lifetimeNet,
      weeklyWishlistAdds,
      followersTotal: followersLatest?.followerCount ?? null,
      weeklyFollowerAdds,
      rankSunday,
      rankPriorSunday,
      rankDelta,
      igdbHype: igdbLatest?.hypeScore ?? null,
    };
  });
}

export interface WeeklyMover {
  productId: number;
  title: string;
  headerImage: string;
  delta: number;
  direction: "up" | "down";
}

function pickBiggestWeeklyMover(
  rows: WeeklyWishlistRow[],
  key: "weeklyWishlistAdds" | "weeklyFollowerAdds" | "rankDelta",
): WeeklyMover | null {
  let best: WeeklyMover | null = null;
  for (const row of rows) {
    const delta = row[key];
    if (delta == null || delta === 0) continue;
    if (best == null || Math.abs(delta) > Math.abs(best.delta)) {
      best = { productId: row.productId, title: row.title, headerImage: row.headerImage, delta, direction: delta > 0 ? "up" : "down" };
    }
  }
  return best;
}

export interface WeeklyWishlistKpis {
  totalWishlistAdds: number; // sum across all titles with data
  totalFollowerAdds: number;
  biggestWishlistMover: WeeklyMover | null;
  biggestRankMover: WeeklyMover | null;
  biggestFollowerMover: WeeklyMover | null;
}

export function getWeeklyWishlistKpis(rows: WeeklyWishlistRow[]): WeeklyWishlistKpis {
  return {
    totalWishlistAdds: rows.reduce((sum, r) => sum + (r.weeklyWishlistAdds ?? 0), 0),
    totalFollowerAdds: rows.reduce((sum, r) => sum + (r.weeklyFollowerAdds ?? 0), 0),
    biggestWishlistMover: pickBiggestWeeklyMover(rows, "weeklyWishlistAdds"),
    biggestRankMover: pickBiggestWeeklyMover(rows, "rankDelta"),
    biggestFollowerMover: pickBiggestWeeklyMover(rows, "weeklyFollowerAdds"),
  };
}

// ─── Weekly Revenue Leaderboard data ────────────────────────────────────────

export interface WeeklyRevenueRow {
  productId: number;
  title: string;
  steamAppId: string;
  headerImage: string;
  baseUnitsWeek: number;
  baseRevenueWeek: number;
  dlcUnitsWeek: number;
  dlcRevenueWeek: number;
  totalRevenueWeek: number;
  ltdRevenueUsd: number | null;
  /** False when the title has zero sales rows in the window AND zero
   * lifetime history — distinguishes "sold nothing this week" from
   * "not yet ingested / brand new". Titles missing sales data entirely due
   * to a cookie gap never reach here because the send is held first. */
  hasAnyLtdHistory: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function getWeeklyRevenueRows(window: WeekWindow): WeeklyRevenueRow[] {
  const titles = getRevenueEligibleSteamTitles();

  return titles.map((p) => {
    const weekRows = storage.getSteamSales(p.id, { since: window.weekStart, until: window.weekEnd });
    const summary = storage.getSteamSalesSummary(p.id);

    let baseUnitsWeek = 0, baseRevenueWeek = 0, dlcUnitsWeek = 0, dlcRevenueWeek = 0;
    for (const r of weekRows) {
      if (r.skuGroup === "base") {
        baseUnitsWeek += r.netUnits;
        baseRevenueWeek += r.netRevenueUsd;
      } else if (r.skuGroup === "dlc") {
        dlcUnitsWeek += r.netUnits;
        dlcRevenueWeek += r.netRevenueUsd;
      }
      // 'other' (soundtrack/artbook/etc.) excluded from the digest's
      // game/DLC revenue split, matching the existing revenue-leaderboard
      // convention in leaderboards.ts.
    }

    const hasAnyLtdHistory = summary.rowCount > 0;
    const ltdRevenueUsd = hasAnyLtdHistory ? round2(summary.baseNetRevenueUsd + summary.dlcNetRevenueUsd) : null;

    return {
      productId: p.id,
      title: p.title,
      steamAppId: p.steamAppId!,
      headerImage: resolveHeaderImage(p.steamAppId!, p.steamHeaderImageUrl ?? null),
      baseUnitsWeek,
      baseRevenueWeek: round2(baseRevenueWeek),
      dlcUnitsWeek,
      dlcRevenueWeek: round2(dlcRevenueWeek),
      totalRevenueWeek: round2(baseRevenueWeek + dlcRevenueWeek),
      ltdRevenueUsd,
      hasAnyLtdHistory,
    };
  });
}

export interface WeeklyRevenueMover extends WeeklyMover {
  isPercent?: boolean;
}

function pickBiggestRevenueMover(
  rows: WeeklyRevenueRow[],
  key: "baseUnitsWeek" | "totalRevenueWeek",
): WeeklyRevenueMover | null {
  let best: WeeklyRevenueMover | null = null;
  for (const row of rows) {
    const raw = row[key];
    if (raw == null || raw === 0) continue;
    if (best == null || Math.abs(raw) > Math.abs(best.delta)) {
      best = { productId: row.productId, title: row.title, headerImage: row.headerImage, delta: raw, direction: raw > 0 ? "up" : "down" };
    }
  }
  return best;
}

export interface WeeklyRevenueKpis {
  totalUnitsWeek: number; // base units only, matches units mover semantics below
  totalRevenueWeek: number; // base + dlc
  biggestUnitsMover: WeeklyRevenueMover | null;
  biggestRevenueMover: WeeklyRevenueMover | null;
}

export function getWeeklyRevenueKpis(rows: WeeklyRevenueRow[]): WeeklyRevenueKpis {
  return {
    totalUnitsWeek: rows.reduce((sum, r) => sum + r.baseUnitsWeek, 0),
    totalRevenueWeek: round2(rows.reduce((sum, r) => sum + r.totalRevenueWeek, 0)),
    biggestUnitsMover: pickBiggestRevenueMover(rows, "baseUnitsWeek"),
    biggestRevenueMover: pickBiggestRevenueMover(rows, "totalRevenueWeek"),
  };
}

// ─── Sales-gap detection (hold gate) ────────────────────────────────────────
//
// Gating signal: steam_sales_upload_batches with id `daily-cron-{productId}-
// {date}` is the ONLY reliable "ingestion ran for this title+day" sentinel
// (see ingestion.ts::ingestSteamSales). It's created whenever the nightly
// portal fetch succeeds for that title/day, REGARDLESS of whether any sales
// rows resulted (a $0 day still creates the batch) — so batch presence, not
// steam_sales_daily row presence, is what "ran" means. Absent-row-means-zero
// only holds for days ingestion actually ran.

export interface DigestGapInfo {
  hasGaps: boolean;
  missingByProduct: Record<number, string[]>; // productId -> missing YYYY-MM-DD dates
}

export function detectSalesGaps(window: WeekWindow): DigestGapInfo {
  const titles = getRevenueEligibleSteamTitles();
  const missingByProduct: Record<number, string[]> = {};

  for (const p of titles) {
    // v3.20: Cover EVERY ingestion path, not just the nightly `daily-cron-`
    // sentinel. A held gap can legitimately be cleared by re-running the
    // nightly cron for "yesterday" (daily-cron-*), the day-by-day portal
    // backfill job (portal-daily-*), an ad-hoc single/multi-day portal
    // fetch (portal-*), or a manual CSV upload (sales-*) — all of them
    // write a steam_sales_upload_batches row with reportDateStart/
    // reportDateEnd populated. Checking batch-ID prefix alone (the old
    // behavior) only recognized the nightly cron and would leave a digest
    // stuck HELD forever if the operator recovered via any other path,
    // e.g. backfilling a date that has since rolled past "yesterday".
    // We still key off batch existence (not sales-row existence) because a
    // legitimately zero-sales day writes a batch with zero rows.
    const allBatches = storage.getSteamSalesUploadBatches(p.id);
    if (allBatches.length === 0) {
      // This title has never had an ingested day at all (e.g. it just
      // became revenue-eligible, or it's CSV-upload-only with nothing yet).
      // Nothing to compare against — don't block the whole digest on a
      // title with zero ingestion history; per advisor guidance, only
      // require coverage for dates >= the title's first-ever batch.
      continue;
    }
    const earliestDate = allBatches.reduce((min, b) => {
      const d = b.reportDateStart ?? null;
      return d !== null && (min === null || d < min) ? d : min;
    }, null as string | null);
    if (earliestDate === null) continue; // no batch has a usable start date yet

    const coveredDates = new Set<string>();
    for (const b of allBatches) {
      const start = b.reportDateStart ?? undefined;
      const end = b.reportDateEnd ?? b.reportDateStart ?? undefined;
      if (!start || !end) continue;
      for (const d of enumerateDates(start, end)) coveredDates.add(d);
    }

    const datesToCheck = enumerateDates(window.weekStart, window.weekEnd).filter((d) => d >= earliestDate);
    const missing = datesToCheck.filter((d) => !coveredDates.has(d));
    if (missing.length > 0) missingByProduct[p.id] = missing;
  }

  return { hasGaps: Object.keys(missingByProduct).length > 0, missingByProduct };
}

// ─── Hold-state persistence (appSettings key/value, no schema migration) ────

const HOLD_WEEK_KEY = "digest_held_week";
const HOLD_MISSING_KEY = "digest_held_missing";

export function getHeldDigestWeek(): WeekWindow | null {
  const raw = storage.getSetting(HOLD_WEEK_KEY)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.weekStart === "string" && typeof parsed.weekEnd === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function getHeldDigestMissing(): Record<number, string[]> {
  const raw = storage.getSetting(HOLD_MISSING_KEY)?.value;
  if (!raw) return {};
  try {
    return JSON.parse(raw) ?? {};
  } catch {
    return {};
  }
}

export function setHeldDigestWeek(window: WeekWindow, missingByProduct: Record<number, string[]>): void {
  storage.upsertSetting(HOLD_WEEK_KEY, JSON.stringify(window));
  storage.upsertSetting(HOLD_MISSING_KEY, JSON.stringify(missingByProduct));
}

export function clearHeldDigestWeek(): void {
  storage.upsertSetting(HOLD_WEEK_KEY, "");
  storage.upsertSetting(HOLD_MISSING_KEY, "");
}
