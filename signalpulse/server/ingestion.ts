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
import { fetchFollowerCount } from "./steam-followers";
import { fetchIgdbHypesBySteamAppids } from "./igdb";
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
//
// v2.0 (2026-07-22): rebuilt against the *correct* Steamworks Partner API.
// The old code called ISteamUserStats/GetAppWishlistReporting, which does
// not exist (404 — "Method 'GetAppWishlistReporting' not found in interface
// 'ISteamUserStats'"). The real endpoint lives on IPartnerFinancialsService
// and requires a Web API key created in a Steamworks group with Financial
// permissions. Docs: https://partner.steamgames.com/doc/webapi/IPartnerFinancialsService
//
// Each call returns DAILY DELTAS for one `date` (GMT), not a running total.
// Data is only final a few hours after the target day ends in GMT, so we
// always request YESTERDAY's date, never today's.

export const STEAM_PARTNER_FINANCIALS_BASE = "https://partner.steam-api.com/IPartnerFinancialsService/GetAppWishlistReporting/v001/";
export const STEAM_PARTNER_DETAILED_SALES_BASE = "https://partner.steam-api.com/IPartnerFinancialsService/GetDetailedSales/v001/";

export interface SteamWishlistReportingApiResponse {
  response: {
    appid: number;
    date: string;
    wishlist_summary: {
      wishlist_adds: number;
      wishlist_deletes: number;
      wishlist_purchases: number;
      wishlist_gifts: number;
      wishlist_adds_windows: number;
      wishlist_adds_mac: number;
      wishlist_adds_linux: number;
    };
    country_summary?: unknown[];
    language_summary?: unknown[];
    app_min_date?: string | null;
  };
}

/** Returns YYYY-MM-DD for "yesterday" in GMT, matching Steam's date-bounding. */
export function getYesterdayGmtDateString(): string {
  return new Date(Date.now() - 86400000).toISOString().split("T")[0];
}

/**
 * Returns YYYY-MM-DD for "yesterday" in Pacific Time. GetDetailedSales is
 * date-bounded in PT (unlike GetAppWishlistReporting which uses GMT). We
 * use Intl.DateTimeFormat with the America/Los_Angeles zone rather than
 * a hardcoded offset so DST is handled correctly year-round.
 */
export function getYesterdayPtDateString(): string {
  const yesterdayUtc = new Date(Date.now() - 86400000);
  // en-CA locale outputs YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(yesterdayUtc);
}

// ─── Steam Detailed Sales ────────────────────────────────────────────────────
//
// A row from IPartnerFinancialsService/GetDetailedSales. See:
//   https://partner.steamgames.com/doc/webapi/IPartnerFinancialsService
//
// Only the fields signalpulse currently consumes are typed here. Full field
// list per Valve docs is much larger (country_code, currency, base_price,
// combined_discount_id, net_tax_usd, etc.) — extend as needed.
export interface SteamDetailedSalesResultItem {
  partnerid: number;
  date: string;
  /** "Package" (for package sales / CD-key activations) or "MicroTxn" (in-game). */
  line_item_type: string;
  /** "Steam" for direct Steam sales, "Retail" for CD-key activations. */
  package_sale_type?: string;
  packageid?: number;
  appid?: number;
  primary_appid?: number;
  net_units_sold?: number;
  gross_units_sold?: number;
  gross_units_activated?: number;
}

export interface SteamDetailedSalesApiResponse {
  response?: {
    results?: SteamDetailedSalesResultItem[];
    /** Max id in returned batch; use as next highwatermark_id until it == input. */
    max_id?: string | number;
  };
}

/**
 * Fetches one PT day of detailed-sales data from GetDetailedSales,
 * paginating with highwatermark_id until Valve reports no more records.
 * Returns the concatenated list of line items.
 *
 * Pagination protocol (per Valve docs):
 *   - Start with highwatermark_id=0.
 *   - On each response, if max_id > input hwm, use max_id as next hwm.
 *   - When max_id == input hwm, no more records.
 *
 * Failure modes:
 *   - HTTP error → returns { ok:false, error }
 *   - 200 with empty response → returns { ok:true, items:[] } (common
 *     when key lacks Sales scope; caller decides how to surface that)
 *   - Loop safety cap at 100 iterations to prevent infinite loops if
 *     Valve regresses the protocol.
 */
export async function fetchSteamDetailedSalesDay(
  apiKey: string,
  datePt: string,
): Promise<
  | { ok: true; items: SteamDetailedSalesResultItem[] }
  | { ok: false; error: string }
> {
  const items: SteamDetailedSalesResultItem[] = [];
  let hwm = "0";
  const maxIterations = 100;
  for (let i = 0; i < maxIterations; i++) {
    const url = `${STEAM_PARTNER_DETAILED_SALES_BASE}?key=${apiKey}&date=${datePt}&highwatermark_id=${hwm}&include_view_grants=true`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      return { ok: false, error: `HTTP ${resp.status} — ${bodyText.slice(0, 200)}` };
    }
    const data = (await resp.json()) as SteamDetailedSalesApiResponse;
    const pageItems = data?.response?.results ?? [];
    items.push(...pageItems);

    const maxId = String(data?.response?.max_id ?? "0");
    if (maxId === hwm) {
      // No more records available for this date.
      break;
    }
    hwm = maxId;
  }
  return { ok: true, items };
}

/**
 * Sums up prepurchase units for a single app from a bag of GetDetailedSales
 * line items. A prepurchase is any Package sale (line_item_type="Package",
 * package_sale_type="Steam") whose primary_appid matches. Uses net_units_sold
 * (gross minus returns) as the counted quantity — matches how signalpulse's
 * cumulativeCount is meant to track "net units in customers' hands".
 *
 * Note: We do NOT filter by date-vs-release-date here; the calling code is
 * expected to only invoke this for dates BEFORE the product's release date.
 * That keeps this helper single-purpose and testable.
 */
export function countAppPrepurchaseUnits(
  items: SteamDetailedSalesResultItem[],
  appId: number,
): number {
  let total = 0;
  for (const item of items) {
    if (item.line_item_type !== "Package") continue;
    if (item.package_sale_type !== "Steam") continue;
    if (item.primary_appid !== appId) continue;
    const n = Number(item.net_units_sold ?? 0);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

/**
 * Fetches one day of wishlist reporting data for a single app from the
 * Steamworks Partner Financials API. Throws on network error; returns a
 * structured result on HTTP-level failure so callers can decide how to
 * surface it (ingestion aggregates errors per-product; backfill aggregates
 * per-day).
 */
export async function fetchSteamWishlistReportingDay(
  apiKey: string,
  appId: string,
  date: string,
): Promise<
  | { ok: true; data: SteamWishlistReportingApiResponse }
  | { ok: false; error: string }
> {
  const url = `${STEAM_PARTNER_FINANCIALS_BASE}?key=${apiKey}&appid=${appId}&date=${date}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    return { ok: false, error: `HTTP ${resp.status} — ${bodyText.slice(0, 200)}` };
  }
  const data = await resp.json() as SteamWishlistReportingApiResponse;
  if (!data?.response || data.response.wishlist_summary == null) {
    return { ok: false, error: `200 OK but no response.wishlist_summary field. Body: ${JSON.stringify(data).slice(0, 200)}` };
  }
  return { ok: true, data };
}

/**
 * Persists one day of wishlist reporting data: upserts the raw daily-delta
 * row into steam_wishlist_reporting_daily, AND computes+upserts a running
 * cumulative into the legacy steam_wishlist_daily table so existing
 * dashboards (which read cumulativeCount) keep working.
 *
 * Cumulative formula: newCumulative = latestKnownCumulative + (adds - deletes - purchases)
 * Gifts are treated as neutral (not subtracted) — see note below.
 */
export function persistSteamWishlistReportingDay(
  productId: number,
  date: string,
  data: SteamWishlistReportingApiResponse,
  source: "api" | "csv-backfill" = "api",
): void {
  const s = data.response.wishlist_summary;
  const fetchedAt = new Date().toISOString();

  storage.upsertSteamWishlistReporting({
    productId,
    date,
    wishlistAdds: s.wishlist_adds,
    wishlistDeletes: s.wishlist_deletes,
    wishlistPurchases: s.wishlist_purchases,
    wishlistGifts: s.wishlist_gifts,
    wishlistAddsWindows: s.wishlist_adds_windows,
    wishlistAddsMac: s.wishlist_adds_mac,
    wishlistAddsLinux: s.wishlist_adds_linux,
    countrySummaryJson: data.response.country_summary ? JSON.stringify(data.response.country_summary) : null,
    languageSummaryJson: data.response.language_summary ? JSON.stringify(data.response.language_summary) : null,
    fetchedAt,
    source,
  });

  // Compute a running cumulative for the legacy steam_wishlist_daily table.
  // We look up the latest known cumulative STRICTLY BEFORE `date` so that
  // re-running/backfilling a day is idempotent and doesn't double-count.
  const priorRows = storage.getSteamWishlists(productId).filter(r => r.date < date);
  const latestPrior = priorRows.length > 0 ? priorRows[priorRows.length - 1] : undefined;
  const latestKnownCumulative = latestPrior?.cumulativeCount ?? 0;

  // NOTE on gifts: Steam's docs are ambiguous about whether a "gift" (a
  // wishlisted item purchased as a gift for someone else) removes the item
  // from the recipient's original wishlist the same way a direct purchase
  // does. We deliberately do NOT subtract wishlist_gifts from the cumulative
  // — a gift is economically similar to a purchase (conversion, not churn),
  // but since the docs don't confirm it decrements the count, we treat it as
  // neutral rather than risk under-counting the wishlist. If Steam's docs are
  // later clarified, update this formula.
  const netChange = s.wishlist_adds - s.wishlist_deletes - s.wishlist_purchases;
  const newCumulative = Math.max(0, latestKnownCumulative + netChange);

  storage.addSteamWishlist({
    productId,
    date,
    cumulativeCount: newCumulative,
    dailyDelta: netChange,
    source,
  });
}

async function ingestSteamData(apiKey: string, partnerId: string): Promise<IngestionResult> {
  const products = storage.getAllProducts();
  const saberProducts = products.filter(p => p.isSaberPublished && p.steamAppId);

  if (saberProducts.length === 0) {
    return { source: "steam", status: "skipped", message: "No Saber-published titles with Steam App IDs" };
  }

  // Data is only final a few hours after the target GMT day ends, so the
  // cron always requests YESTERDAY's date, never today's.
  const targetDate = getYesterdayGmtDateString();
  let dataPoints = 0;
  // v1.2 (2026-07-22): surface Steam API failures per product so users
  // can diagnose 'ingestion ran but 0 data points added' -- e.g. wrong
  // key scope, app not associated with partner, or Steam server error.
  const productErrors: Array<{ productId: number; title: string; error: string }> = [];

  for (const product of saberProducts) {
    try {
      const result = await fetchSteamWishlistReportingDay(apiKey, product.steamAppId!, targetDate);

      if (!result.ok) {
        productErrors.push({ productId: product.id, title: product.title, error: `wishlist: ${result.error}` });
        log(`Steam wishlist ${result.error} for ${product.title} (appid=${product.steamAppId})`, "ingestion");
      } else {
        persistSteamWishlistReportingDay(product.id, targetDate, result.data, "api");
        dataPoints++;
      }

      // Steam sales/prepurchase data — v2.1 (2026-08-11): daily unit sales
      // for ALL Saber products, not just pre-release ones.
      //
      // The old code (v1) called ISteamUserStats/GetAppPrepurchaseReporting/v1/,
      // which does not exist. v2.0 fixed the endpoint but only ran for dates
      // before the product's release milestone — which meant SM2 (and every
      // other launched title) never had unit sales ingested.
      //
      // v2.1 fetches daily sales for EVERY Saber product regardless of
      // release state. The current `steam_prepurchase_daily` table is
      // repurposed as a general "units sold" tracker. Pre-launch rows
      // represent prepurchases; post-launch rows represent regular sales.
      // Both are net_units_sold from GetDetailedSales filtered by
      // primary_appid.
      //
      // Prepurchase Start milestone is now used only as a lower bound to
      // avoid ingesting for products that haven't opened for purchase yet.
      // If a product has no Prepurchase Start milestone AND no Release
      // milestone, we still attempt — GetDetailedSales returning empty is
      // a safe outcome.
      //
      // OPTIMIZATION: In this loop we fetch sales per-product. Since
      // GetDetailedSales returns ALL Saber sales for the day (not scoped
      // to a single appid), this is O(products) duplicate API calls per
      // ingestion run. Acceptable for the current 3-product portfolio,
      // but should be hoisted OUTSIDE the loop once >5 products or when
      // rate limits become a concern. See TODO below.
      //
      // NOTE 1: Sales data requires the "Sales & Activations Reporting"
      // sub-permission on the API key, which is a DIFFERENT scope than
      // wishlist reporting. As of 2026-08-11, the configured key has
      // wishlist scope but not sales scope, so all sales calls return
      // empty {response:{}}. Once scope is added, this code starts
      // filling data automatically with zero further changes.
      // Verified via steam-api-probe.yml workflow across multiple dates.
      //
      // NOTE 2: Dates for GetDetailedSales are Pacific Time, not GMT
      // (wishlist reporting uses GMT — different conventions per endpoint).
      const plsMilestones = storage.getPlsMilestones(product.id);
      const prepurchaseStart = plsMilestones.find(m => m.name === "Prepurchase Start");
      const prepurchaseActive = !!prepurchaseStart?.actualDate;

      // Only attempt sales if the product has been opened for purchase
      // (prepurchase start OR release has actually happened). Products in
      // pre-announcement have no sales endpoint data by definition.
      const releaseMilestone = plsMilestones.find(m => m.name === "Release");
      const releaseHappened = !!releaseMilestone?.actualDate;
      const purchasableAtSomePoint = prepurchaseActive || releaseHappened;

      if (purchasableAtSomePoint) {
        // TODO(perf): hoist this fetch out of the per-product loop; sales
        // response is portfolio-wide, so calling per-product duplicates work.
        const targetDatePt = getYesterdayPtDateString();
        const salesResult = await fetchSteamDetailedSalesDay(apiKey, targetDatePt);
        if (!salesResult.ok) {
          productErrors.push({
            productId: product.id,
            title: product.title,
            error: `sales: ${salesResult.error}`,
          });
          log(`Steam sales fetch failed for ${product.title}: ${salesResult.error}`, "ingestion");
        } else {
          const appIdNum = Number(product.steamAppId);
          const unitsToday = countAppPrepurchaseUnits(salesResult.items, appIdNum);

          const latest = storage.getLatestSteamPrepurchase(product.id);
          const prevCumulative = latest?.cumulativeCount ?? 0;
          const newCumulative = prevCumulative + unitsToday;

          storage.addSteamPrepurchase({
            productId: product.id,
            date: targetDate,
            cumulativeCount: newCumulative,
            dailyDelta: unitsToday,
            source: "api",
          });

          if (unitsToday === 0 && salesResult.items.length === 0) {
            log(`Steam sales for ${product.title}: 0 line items returned (likely missing Sales scope on API key)`, "ingestion");
          } else if (unitsToday === 0 && salesResult.items.length > 0) {
            log(`Steam sales for ${product.title}: ${salesResult.items.length} line items in response but 0 matched appid=${appIdNum}`, "ingestion");
          }
          dataPoints++;
        }
      } else {
        log(`Steam sales skipped for ${product.title}: neither prepurchase nor release has happened`, "ingestion");
      }
    } catch (err) {
      productErrors.push({ productId: product.id, title: product.title, error: `wishlist: ${String(err)}` });
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
    message: `Processed ${saberProducts.length} Saber-published Steam titles for ${targetDate}${errorSummary}`,
    productsProcessed: saberProducts.length,
    dataPointsAdded: dataPoints,
  };
}

// ─── Steam Leaderboards Ingestion (Wishlist board) ─────────────────
//
// Three independent, always-attempted ingestors backing the Saber
// Pre-Release Steam Wishlist Leaderboard (CLAUDE_STEAM_LEADERBOARDS.md).
// None of these require the Steamworks Partner API key that gates
// ingestSteamData()/ingestSonyData() above — they hit public Steam
// endpoints (followers, wishlist rank) or IGDB (hype), so they run
// unconditionally from runIngestion() and self-report skip/error status
// per-source instead of being gated behind an `if (apiKey)` check.

const WISHLIST_BASE =
  "https://store.steampowered.com/search/results/?filter=popularwishlist&json=1&count=25&ndl=1";
const APPID_FROM_LOGO = /steam\/apps\/(\d+)\//;
const WISHLIST_PAGE_SIZE = 25;
const WISHLIST_MAX_PAGES = 12; // safety cap: 12 * 25 = 300 raw fetches worst case
const WISHLIST_TARGET = 200;

/** Returns YYYY-MM-DD for "today" in UTC — the ingestion-run date used across all three Steam Leaderboards tables. */
function getTodayDateString(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Returns pre-release Saber-published titles with a Steam App ID —
 * "pre-release" = releaseDate is set AND strictly after today. A title
 * with no releaseDate (TBD) is treated as pre-release (it hasn't released).
 */
function getPreReleaseSaberSteamTitles() {
  const today = getTodayDateString();
  return storage.getAllProducts().filter(
    (p) => p.isSaberPublished && p.steamAppId && (!p.releaseDate || p.releaseDate > today),
  );
}

/**
 * Follower counts (public steamcommunity.com scrape — see server/steam-
 * followers.ts for why there's no Steamworks API path). Runs 1 req/sec
 * between titles, staleness-ordered (oldest/never-fetched first) so a
 * transient failure on one title doesn't starve the rest of their daily
 * refresh — a title stuck on an old date sorts to the front next run.
 *
 * On a failed fetch we STILL upsert a row for today with followerCount=
 * null, dailyDelta=null — this marks the title as "attempted today" so
 * it doesn't get re-picked to the front of the staleness order on the
 * next run (which would otherwise starve titles behind it every day the
 * community endpoint happens to be down for one appid).
 */
async function ingestSteamFollowers(): Promise<IngestionResult> {
  const titles = getPreReleaseSaberSteamTitles();
  if (titles.length === 0) {
    return { source: "steam_followers", status: "skipped", message: "No pre-release Saber titles with Steam App IDs" };
  }

  // Staleness order: titles with the oldest (or no) getLatestSteamFollowers
  // date go first, so a slow/throttled run still refreshes the most
  // overdue titles before it might get cut short.
  const ordered = [...titles].sort((a, b) => {
    const aDate = storage.getLatestSteamFollowers(a.id)?.date ?? "";
    const bDate = storage.getLatestSteamFollowers(b.id)?.date ?? "";
    return aDate < bDate ? -1 : aDate > bDate ? 1 : 0;
  });

  const today = getTodayDateString();
  let dataPoints = 0;
  let failures = 0;

  for (let i = 0; i < ordered.length; i++) {
    const product = ordered[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 1000)); // 1 req/sec between titles

    // Baseline for the delta must be the latest row STRICTLY BEFORE today,
    // never today's own row — otherwise a second run on the same day (a
    // manual re-trigger, a retry after a partial failure) would diff
    // today's count against itself and silently collapse a real delta to
    // zero/null. getSteamFollowers() returns ascending history for this
    // exact reason: we can walk it backwards and skip today's date.
    const priorRows = storage.getSteamFollowers(product.id).filter((r) => r.date < today);
    const prev = priorRows.length > 0 ? priorRows[priorRows.length - 1] : undefined;

    const existingToday = storage.getLatestSteamFollowers(product.id);
    const hasGoodDataToday = existingToday?.date === today && existingToday.followerCount != null;

    try {
      const count = await fetchFollowerCount(Number(product.steamAppId));
      if (count == null) {
        failures++;
        if (!hasGoodDataToday) {
          // Only write the null "attempted" marker if we don't already have
          // a good value for today — a later same-day retry failing must
          // never clobber an earlier same-day success.
          storage.upsertSteamFollowers({
            productId: product.id,
            date: today,
            followerCount: null,
            dailyDelta: null,
            source: "public_scrape",
          });
        }
        log(`Steam followers: fetch failed for ${product.title} (appid=${product.steamAppId})`, "ingestion");
        continue;
      }

      // No prior-day baseline (first-ever fetch, or every earlier row was a
      // failed-attempt null) — persist delta as null, not 0, so the UI can
      // render "—" instead of fabricating "no change".
      const delta = prev?.followerCount != null ? count - prev.followerCount : null;

      storage.upsertSteamFollowers({
        productId: product.id,
        date: today,
        followerCount: count,
        dailyDelta: delta,
        source: "public_scrape",
      });
      dataPoints++;
    } catch (err) {
      failures++;
      log(`Steam followers ingestion error for ${product.title}: ${err}`, "ingestion");
    }
  }

  return {
    source: "steam_followers",
    status: failures > 0 && dataPoints === 0 ? "error" : "success",
    message: `Refreshed followers for ${dataPoints}/${ordered.length} pre-release titles${failures > 0 ? ` (${failures} failed)` : ""}`,
    productsProcessed: ordered.length,
    dataPointsAdded: dataPoints,
  };
}

/**
 * Steam Wishlist Rank — one paginated fetch of Steam's public
 * "popularwishlist" listing (top ~200 upcoming titles by wishlist count),
 * then a single in-memory lookup per pre-release Saber title. Matches
 * howmanyareplaying's fetchWishlistedGames constants exactly (PAGE_SIZE=25,
 * MAX_PAGES=12, TARGET=200) — see CLAUDE_STEAM_LEADERBOARDS.md §9.5.
 *
 * A pre-release title outside the top-200 that day gets rank=null
 * ("unranked"), not an error. The 7-day rank delta is computed at READ
 * time (storage.getSteamWishlistRankDaysAgo), not stored here.
 */
async function ingestSteamWishlistRank(): Promise<IngestionResult> {
  const titles = getPreReleaseSaberSteamTitles();
  if (titles.length === 0) {
    return { source: "steam_wishlist_rank", status: "skipped", message: "No pre-release Saber titles with Steam App IDs" };
  }

  const rankByAppid = new Map<number, number>();
  try {
    const seen = new Set<number>();
    for (let page = 0; page < WISHLIST_MAX_PAGES; page++) {
      if (seen.size >= WISHLIST_TARGET) break;
      const start = page * WISHLIST_PAGE_SIZE;
      const res = await fetch(`${WISHLIST_BASE}&start=${start}`, {
        headers: { "User-Agent": "signalpulse.saber/wishlist-rank" },
      });
      if (!res.ok) throw new Error(`Steam wishlist API responded ${res.status} at start=${start}`);
      const json = await res.json();
      const items = json?.items;
      if (!Array.isArray(items)) throw new Error(`Unexpected wishlist response shape at start=${start}`);
      if (items.length === 0) break; // end of list
      for (const item of items) {
        const match = item.logo?.match(APPID_FROM_LOGO);
        if (!match || !item.name) continue;
        const appid = parseInt(match[1], 10);
        if (seen.has(appid)) continue;
        seen.add(appid);
        rankByAppid.set(appid, seen.size); // 1-based rank in discovery order
        if (seen.size >= WISHLIST_TARGET) break;
      }
    }
  } catch (err) {
    log(`Steam wishlist rank ingestion error: ${err}`, "ingestion");
    return {
      source: "steam_wishlist_rank",
      status: "error",
      message: `Failed to fetch Steam popularwishlist listing: ${err}`,
    };
  }

  const today = getTodayDateString();
  let dataPoints = 0;
  for (const product of titles) {
    const rank = rankByAppid.get(Number(product.steamAppId)) ?? null;
    storage.upsertSteamWishlistRank({ productId: product.id, date: today, rank });
    dataPoints++;
  }

  return {
    source: "steam_wishlist_rank",
    status: "success",
    message: `Matched ${rankByAppid.size} ranked appids against ${titles.length} pre-release Saber titles`,
    productsProcessed: titles.length,
    dataPointsAdded: dataPoints,
  };
}

/**
 * IGDB Hype Score — one batched POST across ALL Saber titles with a Steam
 * App ID (not pre-release only — hype is meaningful pre- and post-release
 * as a cross-platform interest signal). Gated on both igdb_client_id and
 * igdb_client_secret being set in Settings; skips (not errors) when either
 * is missing so ingestion doesn't spam errors before the user configures
 * IGDB credentials.
 */
async function ingestIgdbHype(): Promise<IngestionResult> {
  const clientId = storage.getSetting("igdb_client_id")?.value;
  const clientSecret = storage.getSetting("igdb_client_secret")?.value;
  if (!clientId || !clientSecret) {
    return { source: "igdb_hype", status: "skipped", message: "IGDB / Twitch credentials not configured in Settings" };
  }

  const titles = storage.getAllProducts().filter((p) => p.isSaberPublished && p.steamAppId);
  if (titles.length === 0) {
    return { source: "igdb_hype", status: "skipped", message: "No Saber titles with Steam App IDs" };
  }

  const today = getTodayDateString();
  try {
    const appids = titles.map((p) => Number(p.steamAppId));
    const hypeMap = await fetchIgdbHypesBySteamAppids(appids);

    let dataPoints = 0;
    for (const product of titles) {
      const match = hypeMap.get(Number(product.steamAppId));
      storage.upsertIgdbHype({
        productId: product.id,
        date: today,
        igdbId: match?.igdbId ?? null,
        hypeScore: match?.hypeScore ?? null,
      });
      dataPoints++;
    }

    return {
      source: "igdb_hype",
      status: "success",
      message: `Matched ${hypeMap.size}/${titles.length} Saber titles to IGDB records`,
      productsProcessed: titles.length,
      dataPointsAdded: dataPoints,
    };
  } catch (err) {
    log(`IGDB hype ingestion error: ${err}`, "ingestion");
    return { source: "igdb_hype", status: "error", message: `Failed to fetch IGDB hype scores: ${err}` };
  }
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

  // 2b. Steam Leaderboards ingestion (Wishlist board) — followers, wishlist
  // rank, and IGDB hype. Unlike Steam/Sony above, these never gate on the
  // Steamworks Partner API key: followers + rank hit public Steam
  // endpoints, and hype hits IGDB. Always attempted; each self-reports
  // skipped/error status if its own precondition (titles present, IGDB
  // creds configured) isn't met.
  log("Ingesting Steam Leaderboards data (followers, wishlist rank, IGDB hype)...", "ingestion");
  const followersResult = await ingestSteamFollowers();
  results.push(followersResult);
  log(`Steam followers: ${followersResult.message}`, "ingestion");

  const wishlistRankResult = await ingestSteamWishlistRank();
  results.push(wishlistRankResult);
  log(`Steam wishlist rank: ${wishlistRankResult.message}`, "ingestion");

  const igdbHypeResult = await ingestIgdbHype();
  results.push(igdbHypeResult);
  log(`IGDB hype: ${igdbHypeResult.message}`, "ingestion");

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
