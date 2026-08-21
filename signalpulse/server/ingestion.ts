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
import { fetchHeaderImage } from "./steam-header-image";
import { fetchIgdbHypesBySteamAppids } from "./igdb";
import { sendSteamCookieExpiryAlert, checkAndReleaseHeldDigest } from "./leaderboard-digest";
import { loadManualAppids, mergeIntoRankMap, detectDrops } from "./wishlist-manual-merge";
import { log } from "./index";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IngestionResult {
  source: string;
  status: "success" | "skipped" | "error";
  message: string;
  productsProcessed?: number;
  dataPointsAdded?: number;
}

export interface IngestionRunResult {
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

  // Wishlist-reporting eligibility (v3.18, 2026-08-13): originally gated to
  // isSaberPublished only, which meant non-Saber-published-but-revenue-active
  // titles (Space Marine 2, Tempest Rising, World War Z, Toxic Commando) never
  // got their steamWishlistSummary card refreshed — those rows went stale
  // indefinitely since nothing else feeds that table (see getSteamWishlistSummary
  // in storage.ts, which reads ONLY from this partner-key path).
  //
  // Confirmed access: manually running POST /api/steam/backfill/:productId for
  // Space Marine 2 (isSaberPublished=false) on 2026-08-13 succeeded immediately
  // against the live Steamworks partner wishlist-reporting endpoint (23/23 days
  // succeeded in the first few seconds of a 1344-day backfill) — the partner key
  // has real reporting access for this title despite Saber not being the Steam
  // publisher of record. User confirmed (2026-08-13) this access extends to the
  // full revenue-eligible portfolio, sales itself coming in separately via the
  // Steamworks cookie session, not this key.
  //
  // Fix: broaden wishlist-reporting eligibility to Saber-published titles UNION
  // revenue-eligible titles (same eligibility already used for the cookie-based
  // sales/revenue leaderboard) — i.e. every title we actually track commercially.
  // Deliberately does NOT touch the legacy sales/prepurchase sub-block further
  // below in this same loop (steam_prepurchase_daily via GetDetailedSales) — that
  // stays isSaberPublished-only, unchanged, since it's a separate superseded path
  // unrelated to this fix.
  const revenueEligibleIds = new Set(getRevenueEligibleSteamTitles().map(p => p.id));
  const saberProducts = products.filter(
    p => p.steamAppId && (p.isSaberPublished || revenueEligibleIds.has(p.id))
  );

  if (saberProducts.length === 0) {
    return { source: "steam", status: "skipped", message: "No Saber-published or revenue-eligible titles with Steam App IDs" };
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
      // Kept isSaberPublished-gated deliberately (v3.18): this legacy
      // GetDetailedSales/steam_prepurchase_daily sub-block is unrelated to the
      // wishlist-reporting broadening above and is superseded by the
      // cookie-based ingestSteamSales() for the revenue leaderboard anyway —
      // don't expand its scope as a side effect of the wishlist fix.
      const purchasableAtSomePoint = product.isSaberPublished && (prepurchaseActive || releaseHappened);

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
        const reason = !product.isSaberPublished
          ? "not Saber-published (revenue tracked separately via cookie-session ingestSteamSales)"
          : "neither prepurchase nor release has happened";
        log(`Steam legacy sales/prepurchase fetch skipped for ${product.title}: ${reason}`, "ingestion");
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
    message: `Processed ${saberProducts.length} Saber-published/revenue-eligible Steam titles for ${targetDate}${errorSummary}`,
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

// v3.14 (2026-08-12): extended rank lookup for titles outside the top-200
// fast path above. Same Steam Store endpoint/filter (filter=popularwishlist)
// — it's the public, unauthenticated listing the storefront's own "Popular
// Upcoming" chart is built from, confirmed to return an exact global rank
// (not just top-200) via `start`/`count` pagination up to `total_count`
// (~5,100 titles as of 2026-08-12). We use a bigger page size here (100 vs
// the 25 used above) since we may need many pages for a low-ranked title.
//
// Steam has no "look up appid X's rank" call -- rank only exists as a
// position in this one public ranked list (confirmed 2026-08-20: not even
// Steamworks partner endpoints expose it; third-party wishlist trackers
// build their own cache from this same public listing). Getting a rank
// unavoidably means walking the list at least once.
//
// v3.34 (2026-08-20): simplified from a per-title seeded-window-then-
// full-scan strategy to ONE shared scan for every unmatched title per run.
// The old approach ran up to 5 separate scan chains (one per title, each
// with its own retry loop) even though we track a small, fixed handful of
// titles -- more independent Steam request chains than necessary, and more
// surface area for a rate-limit to hit. A single combined scan finds every
// title in the same pass of page fetches and stops as soon as all targets
// are found, so it's normally cheaper AND simpler than the windowed version
// it replaces.
const EXTENDED_PAGE_SIZE = 100;
const FULL_SCAN_MAX_PAGES = 60; // 60 * 100 = 6000 items, covers full chart (~5100) with margin
// v3.33 (2026-08-20): widened from 400ms after a same-day production incident
// where Steam 429'd a paginated request at start=900 even after 4 backoff
// retries -- Steam's rate limit on this endpoint is tighter than it was when
// 400ms was chosen. Pacing pages further apart reduces how often we hit it
// at all.
const EXTENDED_REQUEST_DELAY_MS = 1750;

function extendedWishlistUrl(start: number): string {
  return `https://store.steampowered.com/search/results/?query&start=${start}&count=${EXTENDED_PAGE_SIZE}&dynamic_data=&sort_by=_ASC&supportedlang=english&filter=popularwishlist&infinite=1`;
}

/**
 * Fetch one page of the extended popularwishlist listing and return the
 * appids found on it, in rank order, along with the total_count Steam
 * reports for the whole chart (so callers know when to stop paginating).
 */
async function fetchExtendedWishlistPage(
  start: number,
  { attempts = 5 }: { attempts?: number } = {},
): Promise<{ appids: number[]; totalCount: number }> {
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(extendedWishlistUrl(start), {
        headers: { "User-Agent": "signalpulse.saber/wishlist-rank-extended" },
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Steam extended wishlist search responded ${res.status} at start=${start}`);
        // fall through to retry with backoff, same pattern as steam-followers.ts
      } else if (!res.ok) {
        throw new Error(`Steam extended wishlist search responded ${res.status} at start=${start}`);
      } else {
        const json = await res.json();
        const html: string = json?.results_html ?? "";
        const totalCount: number = json?.total_count ?? 0;
        const appids = Array.from(html.matchAll(/data-ds-appid="(\d+)"/g)).map((m) => parseInt(m[1], 10));
        return { appids, totalCount };
      }
    } catch (err: any) {
      lastErr = err;
    }
    if (i < attempts - 1) {
      // v3.33: widened backoff (was 5-15s/10-20s/15-25s/20-30s over 4
      // attempts) -- today's incident hit 429 on every attempt at start=900,
      // so give Steam more room to cool down, with one extra attempt.
      const wait = 8000 + Math.floor(Math.random() * 12000) + i * 7000;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr ?? new Error(`Steam extended wishlist search failed at start=${start}`);
}

/**
 * Scan a range of the extended popularwishlist listing looking for
 * `targetAppids`. Stops as soon as every target is found, the chart is
 * exhausted, or `maxPages` is reached. Returns rank (1-based, global) per
 * found appid. Paces requests at EXTENDED_REQUEST_DELAY_MS apart.
 */
async function scanExtendedWishlistRange(
  targetAppids: Set<number>,
  startOffset: number,
  maxPages: number,
): Promise<Map<number, number>> {
  const found = new Map<number, number>();
  let offset = startOffset;
  for (let page = 0; page < maxPages && found.size < targetAppids.size; page++) {
    let appids: number[];
    let totalCount: number;
    try {
      ({ appids, totalCount } = await fetchExtendedWishlistPage(offset));
    } catch (err) {
      // v3.34 (2026-08-20 incident): a page failing (e.g. Steam 429 after
      // all of fetchExtendedWishlistPage's own retries) used to propagate
      // out of this loop and discard every hit already found on earlier
      // pages in the SAME scan. Stop here instead and return whatever was
      // found so far -- partial results beat losing everything to one bad
      // page deep into the scan.
      log(`Steam extended wishlist page fetch failed at start=${offset}, stopping scan with ${found.size}/${targetAppids.size} found: ${err}`, "ingestion");
      break;
    }
    if (appids.length === 0) break; // end of chart
    appids.forEach((appid, i) => {
      if (targetAppids.has(appid) && !found.has(appid)) {
        found.set(appid, offset + i + 1); // 1-based global rank
      }
    });
    offset += appids.length;
    if (offset >= totalCount) break;
    if (found.size < targetAppids.size) {
      await new Promise((r) => setTimeout(r, EXTENDED_REQUEST_DELAY_MS));
    }
  }
  return found;
}

/**
 * Resolve ranks for titles the top-200 fast path didn't match. One shared
 * scan of Steam's public popularwishlist listing, from WISHLIST_TARGET
 * onward, looking for every unmatched appid at once -- stops as soon as
 * all are found or the chart (or FULL_SCAN_MAX_PAGES) is exhausted.
 * `unmatched` is the list of {appid, productId} pairs still needing a rank.
 */
async function resolveExtendedWishlistRanks(
  unmatched: Array<{ appid: number; productId: number }>,
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (unmatched.length === 0) return result;

  const targets = new Set(unmatched.map((t) => t.appid));
  try {
    const hits = await scanExtendedWishlistRange(targets, WISHLIST_TARGET, FULL_SCAN_MAX_PAGES);
    hits.forEach((rank, appid) => result.set(appid, rank));
  } catch (err) {
    // Non-fatal: whatever the fast top-200 path already matched still gets
    // persisted by the caller. These titles simply keep a null rank for
    // today and get another shot at tomorrow's run.
    log(`Steam extended wishlist rank scan failed for ${targets.size} title(s): ${err}`, "ingestion");
  }

  return result;
}

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
 * ALL titles with a Steam App ID, regardless of isSaberPublished or release
 * status — the full surface that can ever appear on either leaderboard
 * (Wishlist = pre-release Saber subset, Revenue = prepurchase-active-or-
 * released subset, which since v3.17 also includes Focus-published titles
 * like Space Marine 2/Tempest Rising/WWZ/Toxic Commando). Used by
 * ingestHeaderImages() so key art stays cached for a title even after it
 * releases and drops out of getPreReleaseSaberSteamTitles() — the exact gap
 * that left BusBound's header image uncached (falling back to the fragile
 * synthesized Cloudflare path, which 404s for it) after it released and
 * rolled off the pre-release list. v3.17 dropped the isSaberPublished
 * filter here too, since non-Saber-published titles now need cached key
 * art for the Revenue Leaderboard as well.
 */
function getAllSteamTitlesWithAppId() {
  return storage.getAllProducts().filter((p) => !!p.steamAppId);
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
 * Header Images (key art) — caches the REAL Steam appdetails header_image
 * URL on products.steam_header_image_url so the leaderboard doesn't rely
 * on the fragile synthesized cdn.cloudflare.steamstatic.com path (see
 * server/steam-header-image.ts header comment for the full story). Same
 * staleness-ordering + 1 req/sec pacing as ingestSteamFollowers above,
 * since appdetails shares Steam's store-side rate limiting.
 *
 * A failed fetch leaves the existing cached URL untouched (does NOT null
 * it out) — a transient appdetails hiccup should never regress a title
 * that already has a working image back to the broken synthesized one.
 */
async function ingestHeaderImages(): Promise<IngestionResult> {
  const titles = getAllSteamTitlesWithAppId();
  if (titles.length === 0) {
    return { source: "steam_header_image", status: "skipped", message: "No titles with Steam App IDs" };
  }

  // Titles with no cached image yet go first, then by staleness isn't
  // tracked per-row here (no daily table for this — it's a cache column),
  // so we just prioritize "never fetched" over "already has something".
  const ordered = [...titles].sort((a, b) => {
    const aMissing = a.steamHeaderImageUrl ? 1 : 0;
    const bMissing = b.steamHeaderImageUrl ? 1 : 0;
    return aMissing - bMissing;
  });

  let dataPoints = 0;
  let failures = 0;

  for (let i = 0; i < ordered.length; i++) {
    const product = ordered[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 1000)); // 1 req/sec between titles

    try {
      const url = await fetchHeaderImage(Number(product.steamAppId));
      if (url == null) {
        failures++;
        log(`Steam header image: fetch failed for ${product.title} (appid=${product.steamAppId}), keeping existing cached value`, "ingestion");
        continue;
      }
      if (url !== product.steamHeaderImageUrl) {
        storage.updateProductHeaderImage(product.id, url);
      }
      dataPoints++;
    } catch (err) {
      failures++;
      log(`Steam header image ingestion error for ${product.title}: ${err}`, "ingestion");
    }
  }

  return {
    source: "steam_header_image",
    status: failures > 0 && dataPoints === 0 ? "error" : "success",
    message: `Refreshed header images for ${dataPoints}/${ordered.length} pre-release titles${failures > 0 ? ` (${failures} failed, kept existing cached value)` : ""}`,
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
 * v3.14 (2026-08-12): titles NOT found in that top-200 fast path no longer
 * get stuck at rank=null indefinitely. We fall through to
 * resolveExtendedWishlistRanks(), which pages further into the SAME public
 * Steam endpoint (filter=popularwishlist) — it covers the entire chart
 * (~5,100 titles as of this writing), not just the top 200. A title only
 * stays "unranked" now if it's genuinely off the bottom of the chart or
 * the extended scan errors out (logged, non-fatal to the rest of the run).
 * The 7-day rank delta is computed at READ time
 * (storage.getSteamWishlistRankDaysAgo), not stored here.
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

  // Anything not in the top-200 fast path gets a shot at the extended scan.
  const unmatched = titles
    .filter((p) => !rankByAppid.has(Number(p.steamAppId)))
    .map((p) => ({ appid: Number(p.steamAppId), productId: p.id }));

  let extendedCount = 0;
  let extendedError: string | null = null;
  if (unmatched.length > 0) {
    try {
      const extended = await resolveExtendedWishlistRanks(unmatched);
      extended.forEach((rank, appid) => rankByAppid.set(appid, rank));
      extendedCount = extended.size;
    } catch (err) {
      // Non-fatal: fast-path ranks (if any) still get persisted below, and
      // these titles simply keep yesterday's null/rank until the next run.
      extendedError = String(err);
      log(`Steam extended wishlist rank scan error: ${err}`, "ingestion");
    }
  }

  // ─── Manual-insert fallback + drop detector ───────────────────────
  //
  // Steam's popularwishlist endpoint silently omits some appids that ARE
  // publicly ranked — verified for appid 1551980 (Hellraiser) on 2026-08-21
  // across the hmap probe. Without this block, those titles would stamp
  // rank=null every day and drop off the Wishlist Leaderboard's ranked
  // rows entirely, despite still being on Steam's public wishlist ranking.
  //
  // Two independent surfaces:
  //   1. Manual-insert fallback: for appids listed in wishlist-manual-
  //      appids.json that Steam omitted this run, stamp their last-known
  //      rank (or seed_rank if we've never observed one).
  //   2. Drop detector: for any tracked appid recently ranked but missing
  //      this run AND not covered by the manual list, surface it in the
  //      result message so we notice new omissions promptly.
  //
  // See wishlist-manual-merge.ts for the design rationale.
  const trackedAppids = titles
    .map((p) => Number(p.steamAppId))
    .filter((n) => Number.isFinite(n) && n > 0);
  const steamAppidSet = new Set<number>(rankByAppid.keys());

  const manualEntries = await loadManualAppids();
  const lastKnownRanks = storage.getLatestSteamWishlistRankByAppids(
    manualEntries.map((e) => e.appid),
  );
  const mergeResult = mergeIntoRankMap({
    manualEntries,
    lastKnownRanks,
    steamAppidSet,
  });
  // Apply fallbacks — Steam-native rank always wins, so we only fill gaps.
  mergeResult.rankOverrides.forEach((rank, appid) => {
    if (rankByAppid.get(appid) === undefined) {
      rankByAppid.set(appid, rank);
    }
  });
  const manualCoveredAppids = new Set<number>(mergeResult.rankOverrides.keys());

  const DROP_WINDOW_DAYS = 14;
  const rankedDaysInWindow = storage.countRankedDaysInWindowByAppids(trackedAppids, DROP_WINDOW_DAYS);
  const drops = detectDrops({
    trackedAppids,
    steamAppidSet,
    manualCoveredAppids,
    rankedDaysInWindow,
    minRankedDaysForDrop: 1,
  });

  if (mergeResult.metrics.manual_inserts_active > 0) {
    const detail = mergeResult.metrics.inserts_detail
      .filter((d) => d.source !== "none")
      .map((d) => `${d.appid}:${d.name} @${d.fallback_rank}(${d.source})`)
      .join(", ");
    log(
      `[wishlist] manual-merge: configured=${mergeResult.metrics.manual_configured} active=${mergeResult.metrics.manual_inserts_active} recovered=${mergeResult.metrics.manual_inserts_recovered} stale=${mergeResult.metrics.manual_inserts_stale} inserted=[${detail}]`,
      "ingestion",
    );
  }
  if (drops.length > 0) {
    const dropDetail = drops.map((d) => `${d.appid}(${d.ranked_days_in_window}d)`).join(", ");
    log(
      `[wishlist] drop-detector: ${drops.length} tracked appid(s) missing from Steam this run despite recent ranks: ${dropDetail}`,
      "ingestion",
    );
  }

  const today = getTodayDateString();
  let dataPoints = 0;
  for (const product of titles) {
    const rank = rankByAppid.get(Number(product.steamAppId)) ?? null;
    storage.upsertSteamWishlistRank({ productId: product.id, date: today, rank });
    dataPoints++;
  }

  const extendedNote = unmatched.length > 0
    ? ` (extended scan resolved ${extendedCount}/${unmatched.length} titles outside top ${WISHLIST_TARGET}${extendedError ? `; scan error: ${extendedError}` : ""})`
    : "";
  const manualNote = mergeResult.metrics.manual_inserts_active > 0
    ? `; manual-merge active=${mergeResult.metrics.manual_inserts_active} recovered=${mergeResult.metrics.manual_inserts_recovered}`
    : "";
  const dropNote = drops.length > 0
    ? `; drops=${drops.length} [${drops.map((d) => d.appid).join(",")}]`
    : "";

  return {
    source: "steam_wishlist_rank",
    status: "success",
    message: `Matched ${rankByAppid.size} ranked appids against ${titles.length} pre-release Saber titles${extendedNote}${manualNote}${dropNote}`,
    productsProcessed: titles.length,
    dataPointsAdded: dataPoints,
  };
}

/**
 * IGDB Hype Score — one fetch of howmanyareplaying.com's public Top 200
 * upcoming-wishlisted list across ALL Saber titles with a Steam App ID
 * (not pre-release only — hype is meaningful pre- and post-release as a
 * cross-platform interest signal). No credentials required — see
 * server/igdb.ts header for the known Top-200-only coverage limitation.
 */
async function ingestIgdbHype(): Promise<IngestionResult> {
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

/**
 * Returns ALL titles (Saber-published or not — v3.17 dropped the
 * isSaberPublished gate so Focus-published titles like Space Marine 2,
 * Tempest Rising, World War Z, and Toxic Commando are included) eligible
 * for the Revenue Leaderboard — distinct from getPreReleaseSaberSteamTitles()
 * (Wishlist board, still Saber-only), since revenue tracking starts as soon
 * as prepurchases open, not just at release. Per plan §1.4 (as extended):
 * has a steamAppId AND (Prepurchase Start milestone has fired OR the title
 * has released).
 *
 * Safe to overlap with the pre-existing manual portal-daily-backfill /
 * portal-fetch admin routes in routes.ts: steam_sales_daily has a unique
 * index on (productId, date, skuGroup) and upsertSteamSalesRows() does
 * insert-or-update on that key regardless of batchId, so a title ingested
 * by both this cron and a manual backfill for the same date just gets its
 * row overwritten, never duplicated.
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

const PORTAL_FETCH_DELAY_MS = 2000; // ~2s stagger between titles, gentle on Steamworks
// Minimum gap between proactive cookie-expiry alert emails for the SAME
// unresolved failure episode. Daily cron + any manual re-runs while the
// cookie stays broken would otherwise re-send every time; 20h means at
// most ~1 email/day until someone actually fixes the cookie.
const STEAM_COOKIE_ALERT_COOLDOWN_MS = 20 * 60 * 60 * 1000;

/**
 * Daily Steam sales ingestion via the Steamworks partner portal (single-
 * cookie session, shared across all titles). Fetches a one-day snapshot
 * for "yesterday" for every Revenue-Leaderboard-eligible title and
 * upserts into steam_sales_daily with source='portal_fetch'.
 *
 * Idempotent: batchId is deterministic (`daily-cron-{productId}-{date}`),
 * and any existing rows for that batch are purged via
 * storage.deleteSteamSalesByBatch() before re-inserting — NEVER a raw
 * DELETE FROM steam_sales_daily (see v3.13 incident: a raw delete once
 * wiped Space Marine 2's sales history from 1342 to 652 rows).
 *
 * The Steamworks session cookie is shared (id='default'), not per-title —
 * if the first fetch comes back with an expired/redirected session, every
 * subsequent title would fail identically, so we stop iterating early
 * rather than burning ~2s/title on guaranteed failures. The Settings page
 * surfaces session.lastVerifiedResult as a passive warning banner, and on
 * top of that a proactive Resend alert email + an app-wide layout banner
 * fire on detected expiry (see the /session expired/i branch below,
 * client/src/components/layout.tsx, and GET /api/steam/session).
 */
async function ingestSteamSales(): Promise<IngestionResult> {
  const titles = getRevenueEligibleSteamTitles();
  if (titles.length === 0) {
    return {
      source: "steam_sales",
      status: "skipped",
      message: "No titles eligible for revenue ingestion yet (no prepurchase started or release reached)",
    };
  }

  const session = storage.getSteamworksSession("default");
  if (!session) {
    return { source: "steam_sales", status: "skipped", message: "No Steamworks session cookie configured" };
  }

  const { fetchPortalPage, portalToSalesRows } = await import("./steamworks-portal");
  const targetDate = getYesterdayGmtDateString();

  let dataPoints = 0;
  let sessionExpired = false;
  const errors: Array<{ title: string; error: string }> = [];

  for (let i = 0; i < titles.length; i++) {
    const product = titles[i];
    if (i > 0) await new Promise((r) => setTimeout(r, PORTAL_FETCH_DELAY_MS));

    try {
      const result = await fetchPortalPage({
        appId: Number(product.steamAppId),
        dateStart: targetDate,
        dateEnd: targetDate,
        cookieHeader: session.cookieValue,
      });

      const nowIso = new Date().toISOString();
      if (!result.ok || !result.parsed) {
        const errMsg = (result.error ?? "unknown error").slice(0, 200);
        errors.push({ title: product.title, error: errMsg });
        storage.upsertSteamworksSession({
          id: "default",
          cookieValue: session.cookieValue,
          loggedInAs: session.loggedInAs,
          lastVerifiedAt: nowIso,
          lastVerifiedResult: `error: ${errMsg}`,
        });
        log(`Steam sales portal-fetch failed for ${product.title}: ${errMsg}`, "ingestion");
        if (/session expired/i.test(errMsg)) {
          sessionExpired = true;
          // Proactive alert: only fire once per failure episode, not on every
          // cron/manual run while the cookie stays broken. `session` was
          // fetched once at the top of this function, before this run's
          // writes, so it still reflects the alert state from the LAST
          // episode — exactly what the cooldown needs to compare against.
          const lastAlertMs = session.alertSentAt ? new Date(session.alertSentAt).getTime() : 0;
          if (Date.now() - lastAlertMs > STEAM_COOKIE_ALERT_COOLDOWN_MS) {
            storage.setSteamworksSessionAlertSent("default", nowIso);
            sendSteamCookieExpiryAlert(errMsg).catch((e) =>
              log(`Failed to send Steam cookie-expiry alert: ${e}`, "ingestion"));
          } else {
            log("Steam cookie-expiry alert suppressed (within cooldown window)", "ingestion");
          }
          break; // shared cookie — every remaining title would fail the same way
        }
        continue;
      }

      // Deterministic + idempotent: purge any existing rows for today's
      // batch before re-inserting, so re-running the same day never
      // double-counts (matches the portal-daily-backfill convention).
      const batchId = `daily-cron-${product.id}-${targetDate}`;
      storage.deleteSteamSalesByBatch(batchId);
      const rows = portalToSalesRows(result.parsed, product.id, targetDate, batchId);

      storage.createSteamSalesUploadBatch({
        id: batchId,
        productId: product.id,
        filename: `daily-cron-${targetDate}.html`,
        fileBytes: result.htmlBytes ?? 0,
        reportDateStart: targetDate,
        reportDateEnd: targetDate,
        publisherName: null,
        rowsParsed: 1,
        rowsIngested: rows.length,
        rowsSkipped: 0,
        skippedReason: null,
        uploadedBy: "daily-cron",
      });

      if (rows.length > 0) {
        storage.upsertSteamSalesRows(rows);
      }

      storage.upsertSteamworksSession({
        id: "default",
        cookieValue: session.cookieValue,
        loggedInAs: session.loggedInAs,
        lastVerifiedAt: nowIso,
        lastVerifiedResult: "ok",
      });
      // Cookie is verifiably working again — clear any pending alert
      // cooldown so the NEXT expiry (a fresh episode) alerts right away
      // instead of staying silent until the old cooldown window lapses.
      if (session.alertSentAt) {
        storage.setSteamworksSessionAlertSent("default", null);
      }

      dataPoints++;
    } catch (err: any) {
      errors.push({ title: product.title, error: String(err?.message || err) });
      log(`Steam sales ingestion error for ${product.title}: ${err}`, "ingestion");
    }
  }

  const errorSummary = errors.length > 0
    ? ` — ${errors.length} error${errors.length === 1 ? "" : "s"}: ${errors.map((e) => `[${e.title}] ${e.error}`).join("; ")}`
    : "";
  const expiredNote = sessionExpired
    ? " (Steamworks session appears expired — remaining titles skipped; reconnect the cookie in Settings)"
    : "";

  // Check whether this run just filled the gap that was holding the weekly
  // digest (2026-08-14 hold/release gate). Runs regardless of this run's
  // own success/failure — gap detection re-checks the actual ingestion
  // batches, so a run that fixed title A's gap while title B still failed
  // correctly stays held on B. Never throws; failures here don't affect
  // this ingestion result.
  await checkAndReleaseHeldDigest();

  return {
    source: "steam_sales",
    status: dataPoints === 0 && errors.length > 0 ? "error" : "success",
    message: `Ingested daily portal sales for ${dataPoints}/${titles.length} revenue-eligible titles for ${targetDate}${errorSummary}${expiredNote}`,
    productsProcessed: titles.length,
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

  const headerImageResult = await ingestHeaderImages();
  results.push(headerImageResult);
  log(`Steam header images: ${headerImageResult.message}`, "ingestion");

  const wishlistRankResult = await ingestSteamWishlistRank();
  results.push(wishlistRankResult);
  log(`Steam wishlist rank: ${wishlistRankResult.message}`, "ingestion");

  const igdbHypeResult = await ingestIgdbHype();
  results.push(igdbHypeResult);
  log(`IGDB hype: ${igdbHypeResult.message}`, "ingestion");

  const steamSalesResult = await ingestSteamSales();
  results.push(steamSalesResult);
  log(`Steam sales (portal): ${steamSalesResult.message}`, "ingestion");

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

// ─── Manual Per-Source Ingestion Triggers (Settings UI buttons) ────────────
//
// Wrap distinct slices of the pipeline above so operators can force a
// refresh of a single data path from Settings without waiting on/running
// everything runIngestion() does. Each persists its own
// `ingestion_last_run_<source>` setting so the UI can show "last run" after
// a page reload (mirrors the `ingestion_last_run` convention used by the
// full pipeline).
//
// The three paths map 1:1 onto Steamworks' three distinct auth mechanisms:
//   1. Sales Leaderboard   — Steamworks Partner PORTAL SESSION COOKIE
//   2. Wishlist Leaderboard (public parts) — no auth, public Steam endpoints
//   3. Wishlist Leaderboard (actual counts) — Steamworks Partner API KEY

function persistManualIngestionRun(settingKey: string, result: IngestionRunResult): void {
  storage.upsertSetting(settingKey, JSON.stringify(result));
}

/**
 * Sales Leaderboard — Steamworks Partner PORTAL SESSION COOKIE.
 * Same `ingestSteamSales()` used by the full daily pipeline, just invoked
 * on demand. Settings UI: "Steamworks Session Cookie" card.
 */
export async function runSalesIngestionNow(): Promise<IngestionRunResult> {
  const startedAt = new Date().toISOString();
  log("Manual trigger: Sales Leaderboard ingestion (Steamworks cookie)...", "ingestion");
  const result = await ingestSteamSales();
  const completedAt = new Date().toISOString();
  const out: IngestionRunResult = {
    startedAt,
    completedAt,
    results: [result],
    totalProductsProcessed: result.productsProcessed || 0,
    totalDataPointsAdded: result.dataPointsAdded || 0,
  };
  persistManualIngestionRun("ingestion_last_run_sales", out);
  log(`Manual sales ingestion complete: ${result.message}`, "ingestion");
  return out;
}

/**
 * Wishlist Leaderboard, public-data half — no key/cookie required.
 * Follower counts + header art + "Popular Upcoming" wishlist chart rank,
 * all from unauthenticated public Steam endpoints. Settings UI: dedicated
 * "Manual Ingestion" card (no credential to attach it to).
 */
export async function runPublicWishlistIngestionNow(): Promise<IngestionRunResult> {
  const startedAt = new Date().toISOString();
  log("Manual trigger: Wishlist Leaderboard public-API ingestion (followers, rank, header art)...", "ingestion");
  const results: IngestionResult[] = [];
  results.push(await ingestSteamFollowers());
  results.push(await ingestHeaderImages());
  results.push(await ingestSteamWishlistRank());
  const completedAt = new Date().toISOString();
  const out: IngestionRunResult = {
    startedAt,
    completedAt,
    results,
    totalProductsProcessed: results.reduce((sum, r) => sum + (r.productsProcessed || 0), 0),
    totalDataPointsAdded: results.reduce((sum, r) => sum + (r.dataPointsAdded || 0), 0),
  };
  persistManualIngestionRun("ingestion_last_run_public", out);
  log(`Manual public-API wishlist ingestion complete: ${results.map(r => r.message).join(" | ")}`, "ingestion");
  return out;
}

/**
 * Wishlist Leaderboard, actual-counts half — Steamworks Partner API KEY.
 * Pulls Saber/Mad Dog titles' real daily wishlist adds/deletes/purchases via
 * IPartnerFinancialsService (`ingestSteamData`). Note: this same call also
 * attempts a GetDetailedSales unit-sales fetch as a side effect — as of
 * 2026-08-11 that sub-call returns empty because the configured key lacks
 * the "Sales & Activations Reporting" scope (see NOTE 1 in ingestSteamData
 * above), so it's a harmless no-op today, not a second sales path. Settings
 * UI: "Steam / Steamworks" card (same key used to read wishlist counts).
 */
export async function runPartnerWishlistIngestionNow(): Promise<IngestionRunResult> {
  const startedAt = new Date().toISOString();
  log("Manual trigger: Wishlist Leaderboard partner-API-key ingestion (actual wishlist counts)...", "ingestion");
  const apiKey = storage.getSetting("steam_api_key")?.value;
  const partnerId = storage.getSetting("steam_partner_id")?.value;
  let result: IngestionResult;
  if (!apiKey || apiKey.trim().length === 0) {
    result = { source: "steam", status: "skipped", message: "No Steam Partner API key configured in Settings" };
  } else {
    result = await ingestSteamData(apiKey, partnerId || "");
  }
  const completedAt = new Date().toISOString();
  const out: IngestionRunResult = {
    startedAt,
    completedAt,
    results: [result],
    totalProductsProcessed: result.productsProcessed || 0,
    totalDataPointsAdded: result.dataPointsAdded || 0,
  };
  persistManualIngestionRun("ingestion_last_run_partner", out);
  log(`Manual partner-key wishlist ingestion complete: ${result.message}`, "ingestion");
  return out;
}

// ─── Cron Scheduler ──────────────────────────────────────────────────────────
//
// Daily at 3:00 AM America/New_York, covering the full runIngestion()
// pipeline (both leaderboards + everything else it feeds). Uses
// Intl.DateTimeFormat with an explicit America/New_York timeZone rather than
// a fixed UTC hour so the run time doesn't drift across the DST transition
// (03:00 ET is 07:00 UTC in EDT, 08:00 UTC in EST) — same pattern as
// `startWeeklyDigestCron` in leaderboard-digest.ts.
//
// Replaces the old fixed-02:00-UTC version, which was also dead code: it was
// exported but never invoked from anywhere in the codebase (confirmed by a
// repo-wide grep during the 2026-08-13 cron investigation) — so no daily
// ingestion was actually running on any schedule prior to this.

let cronInterval: ReturnType<typeof setInterval> | null = null;
let ingestionCronLastRunDate = "";

function getEasternHourMinute(now: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  const hour = parseInt(get("hour"), 10) % 24; // "24" at midnight with hour12:false
  const minute = parseInt(get("minute"), 10);
  return { hour, minute };
}

export function startIngestionCron(): void {
  if (cronInterval) return; // idempotent
  log("Ingestion cron scheduler started (daily at 03:00 America/New_York)", "ingestion");

  cronInterval = setInterval(() => {
    const now = new Date();
    const { hour, minute } = getEasternHourMinute(now);
    // Use the Eastern calendar date (not UTC) for the once-per-day guard, so
    // the 03:00 ET firing always lands on "today" in the timezone that
    // actually matters here.
    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now); // YYYY-MM-DD

    if (hour === 3 && minute === 0 && ingestionCronLastRunDate !== todayStr) {
      ingestionCronLastRunDate = todayStr;
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
