/**
 * Phase 3 — universe discovery + business_model classification.
 *
 * Populates platform_sku_map with premium-paid titles from each store. Every
 * classification is derived from real store fields, never guessed:
 *   Steam — storefront api/appdetails.is_free  →  paid | free_to_play
 *   Xbox  — displaycatalog DisplaySkuAvailabilities MSRPs (all zero ⇒ F2P)
 *   PS    — productRetrieve GraphQL webctas price (v1: manual seed + refresh)
 *
 * All three collectors above are already in server/signals/console/; discovery
 * here reuses them for the classification side effect where useful (Xbox
 * fetchXboxRatingSignal returns pricing in the same call).
 *
 * PORTABILITY: this file imports storage (SQLite writes) and belongs alongside
 * runner.ts. When ported to howmanyareplaying, only the DB writes change.
 */

import { rawSqlite } from "../../storage";
import { log } from "../../log";
import { fetchJson, todayUtc, type BusinessModel, type ConsolePlatform } from "./types";
import { fetchXboxRatingSignal } from "./xbox";
import { writeRankSnapshot, computeTop50Churn } from "./rankSnapshot";

// ─── SKU-to-base-title remap (2026-09-12) ─────────────────────────────────
//
// Some storefront listings are region variants (US UP-prefix vs EU EP-prefix)
// or edition variants of a title that is already in the DB under a different
// title_id. Without intervention, discovery allocates a fresh title_id for
// each new SKU it sees on the live storefront, which creates a duplicate
// leaderboard row for the same game.
//
// Rather than dropping the SKU entirely (which would lose the region's
// pricing/signal contribution), this map redirects the SKU to the existing
// base title_id. `upsertSkuMap` then writes the row into platform_sku_map
// under that base title_id — the leaderboard row we already display keeps
// its history, and no new duplicate is created.
//
// Keyed on `${platform}:${externalSku}` exactly as it lands in the pipeline.
// Value is the base title_id to absorb it into. Add a comment for every
// entry explaining which base row owns the SKU.
//
// This is a targeted patch for known duplicates, NOT a general remap. Do not
// use it for "titles we don't want on the leaderboard"; use gated_reason /
// release-gate logic for that.
const SKU_BASE_TITLE_ID: ReadonlyMap<string, number> = new Map<string, number>([
  // Resident Evil Requiem — US Deluxe SKU. Base title 10335 owns the EU
  // Deluxe SKU (EP0102-PPSA31246_00-REREQUIEMDX00000) as its base row with
  // the $79.99 msrp; the US variant is the same product on the US
  // storefront and belongs on the same leaderboard row.
  ["ps5:UP0102-PPSA30803_00-REREQUIEMDX00000", 10335],
  // Marvel's Spider-Man 2 — US SKU. Base title 10352 owns the EU SKU
  // (EP9000-PPSA08338_00-MARVELSPIDERMAN2). Same game, US storefront.
  ["ps5:UP9000-PPSA03016_00-MARVELSPIDERMAN2", 10352],
  // Dying Light: The Beast — US SKU. Base title 10386 owns the EU SKU
  // (EP2911-PPSA24003_00-DLTHEBEASTP5EU00). Same game, US storefront.
  ["ps5:UP3050-PPSA24002_00-DLTHEBEASTP5US00", 10386],
  // ─── 2026-09-12 batch: 9 additional US/EU duplicate pairs surfaced by
  //     the m12 flat-value survey. Every pair has an EU (EP-prefix) base row
  //     that pre-dates the US (UP-prefix) discovery seed; the US row inherits
  //     the EU base's title_id so the leaderboard shows a single unified row.
  // Call of Duty®: Modern Warfare® 4 - Vault Edition. Base 10312 (EU EP0002).
  ["ps5:UP0002-PPSA01649_00-CODMW4VAULT00001", 10312],
  // Grand Theft Auto V: Premium Edition & Great White Shark Card Bundle.
  // Base 10318 (EU EP1004). Note: this is the bundled SKU, distinct from base
  // GTA V Enhanced (10021) which Sony sells as its own product.
  ["ps5:UP1004-PPSA03420_00-GTAVANDGWSBUNDLE", 10318],
  // Tom Clancy's Rainbow Six Siege X: Elite Edition. Base 10394 (EU EP0001).
  ["ps5:UP0001-PPSA01396_00-RB6SIEGEELITEY10", 10394],
  // Ghost of Tsushima: Director's Cut. Base 10447 (EU EP9000-PPSA03208).
  ["ps5:UP9000-PPSA02225_00-GHOSTDIRECTORPS5", 10447],
  // God of War Ragnarök. Base 10370 (EU EP9000-PPSA08330).
  ["ps5:UP9000-PPSA08329_00-GOWRAGNAROK00000", 10370],
  // No Man's Sky PS4 & PS5. Base 10350 (EU EP2034-PPSA01412).
  ["ps5:UP2034-PPSA02110_00-NOMANSSKYHG00001", 10350],
  // Astro Bot. Base 10357 (EU EP9000-PPSA21567). The US SKU sits on a
  // sibling productId (PPSA21564) but is the same game.
  ["ps5:UP9000-PPSA21564_00-0000000000000000", 10357],
  // Hitman World of Assassination. Base 10333 (EU EP3969-PPSA01769).
  ["ps5:UP4572-PPSA01768_00-0000000000000WOA", 10333],
  // Final Fantasy VII Rebirth: Digital Deluxe Edition. Base 10364 (EU EP0082-PPSA08668).
  ["ps5:UP0082-PPSA08666_00-0978938405039882", 10364],
]);

function remapTitleId(platform: string, externalSku: string, defaultTitleId: number): number {
  return SKU_BASE_TITLE_ID.get(`${platform}:${externalSku}`) ?? defaultTitleId;
}

// ─── Steam ───────────────────────────────────────────────────────────────────

interface SteamSearchResponse {
  success: number;
  results_html: string;
  total_count: number;
  start: number;
}

interface SteamAppDetailsResponse {
  [appid: string]: {
    success: boolean;
    data?: {
      steam_appid: number;
      name: string;
      is_free: boolean;
      price_overview?: { initial: number; final: number; currency: string };
      type: string;                          // "game" | "dlc" | "demo" | "advertising" | ...
      release_date?: { coming_soon: boolean; date: string };
      header_image?: string;                 // 460×215 store header, included in the `basic` filter set.
    };
  };
}

/**
 * Parse Steam's storefront release_date.date string into an ISO YYYY-MM-DD.
 * Steam returns strings like "22 Sep, 2026", "Sep 22, 2026", "Q4 2026", or
 * "Coming soon". We only accept a full day/month/year form so an unparseable
 * value never lands in the store_release_date column pretending to be real.
 */
export function parseSteamReleaseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || /coming\s*soon|to be announced|tba|q[1-4]|^\d{4}$/i.test(s)) return null;
  // Try native Date parser first — handles both "22 Sep, 2026" and "Sep 22, 2026".
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Fetch the Steam top-sellers list. `hidef2p=1` filters F2P at the SOURCE
 * (defense in depth on top of the ingest gate).
 *
 * Discovery now takes the UNION of two Steam search filters:
 *   1. `topsellers` — the 24-hour top-sellers chart (Steam's primary signal).
 *   2. `new_releases` — the past-month new-releases chart.
 *
 * The topsellers chart aggregates over a rolling 24h window, so a game that
 * launches strong (Halloween: The Game on Sep 8) may not surface for several
 * days. Unioning `new_releases` catches those “hot right now” launches while
 * they are still fresh, so the 7-day leaderboard can flag them via the
 * isRecentHot column.
 */
export async function discoverSteamTopSellers(pages: number = 4): Promise<Array<{ appId: string }>> {
  const seen = new Set<string>();
  const out: Array<{ appId: string }> = [];

  const fetchFilter = async (filter: "topsellers" | "new_releases") => {
    for (let page = 0; page < pages; page++) {
      const start = page * 25;
      const url = `https://store.steampowered.com/search/results/?query=&start=${start}&count=25&filter=${filter}&supportedlang=english&category1=998&hidef2p=1&infinite=1`;
      let resp: SteamSearchResponse;
      try {
        resp = await fetchJson<SteamSearchResponse>(url, { timeoutMs: 15000 });
      } catch (e) {
        log(`steam discovery: ${filter} page ${page} failed: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      const appIds = extractSteamAppIds(resp.results_html || "");
      for (const id of appIds) {
        if (!seen.has(id)) { seen.add(id); out.push({ appId: id }); }
      }
      await new Promise(r => setTimeout(r, 300));
    }
  };

  await fetchFilter("topsellers");
  await fetchFilter("new_releases");
  log(`steam discovery: unioned topsellers + new_releases → ${out.length} appids`);
  return out;
}

function extractSteamAppIds(html: string): string[] {
  const ids: string[] = [];
  const re = /data-ds-appid="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) ids.push(m[1]);
  return ids;
}

/**
 * Classify a batch of Steam appids using the storefront api/appdetails endpoint.
 * Returns per-appid: business_model, msrp_usd_cents, name, type.
 * type='dlc' etc. are marked business_model='unknown' so they don't leak in as paid games.
 */
export interface SteamClassification {
  appId: string;
  businessModel: BusinessModel;
  msrpUsdCents: number | null;
  name: string | null;
  type: string | null;
  // Store-truthed fields captured alongside classification. Fed into
  // bootstrapConsoleTitleNames so the console_title_igdb row keeps a
  // storefront-truthed fallback for header art and release date, even when
  // IGDB later matches the wrong game.
  headerImageUrl: string | null;             // 460×215 header from appdetails.header_image.
  releaseDateIso: string | null;             // Parsed ISO date, null when coming_soon / TBA.
}

export async function classifySteamAppIds(appIds: string[]): Promise<SteamClassification[]> {
  const out: SteamClassification[] = [];
  // appdetails supports batch via comma-separated appids but returns partial data;
  // one-at-a-time is more reliable and Valve rate-limits leniently.
  for (const id of appIds) {
    // filters is a Steam whitelist — `basic` alone does NOT include release_date,
    // so we ask for it explicitly. Without this, release_date comes back null
    // on every appid and the store_release_date column stays empty.
    const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(id)}&cc=us&l=english&filters=basic,price_overview,release_date`;
    try {
      const resp = await fetchJson<SteamAppDetailsResponse>(url, { timeoutMs: 15000 });
      const entry = resp[id];
      if (!entry || !entry.success || !entry.data) {
        out.push({ appId: id, businessModel: "unknown", msrpUsdCents: null, name: null, type: null, headerImageUrl: null, releaseDateIso: null });
        continue;
      }
      const d = entry.data;
      const headerImageUrl = d.header_image ?? null;
      // Coming_soon rows still get a store release_date captured when the string
      // is a real day/month/year (some pre-release games publish an exact date).
      const releaseDateIso = d.release_date?.coming_soon
        ? null
        : parseSteamReleaseDate(d.release_date?.date);
      if (d.type !== "game") {
        // Non-game (DLC, demo, video, application) — do not classify as paid.
        out.push({ appId: id, businessModel: "unknown", msrpUsdCents: null, name: d.name, type: d.type, headerImageUrl, releaseDateIso });
        continue;
      }
      if (d.is_free === true) {
        out.push({ appId: id, businessModel: "free_to_play", msrpUsdCents: 0, name: d.name, type: d.type, headerImageUrl, releaseDateIso });
        continue;
      }
      // Paid game.
      const cents = d.price_overview?.initial ?? null;   // Steam returns integer cents already
      out.push({ appId: id, businessModel: "paid", msrpUsdCents: cents, name: d.name, type: d.type, headerImageUrl, releaseDateIso });
    } catch (e) {
      out.push({ appId: id, businessModel: "unknown", msrpUsdCents: null, name: null, type: null, headerImageUrl: null, releaseDateIso: null });
      log(`steam classify: appid=${id} failed: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise(r => setTimeout(r, 350));
  }
  return out;
}

// ─── Xbox ────────────────────────────────────────────────────────────────────

/**
 * Fetch bigIds from an Xbox browse page. Each Xbox "channel" page renders 25
 * items server-side (page-index query params are ignored — the additional
 * items load client-side via an XHR that requires JS). Combining multiple
 * curated channels gives broader coverage without headless rendering.
 *
 * Retained for callers/tests that still want the HTML-scoped 25 items.
 */
async function fetchXboxChannelBigIds(slug: string): Promise<string[]> {
  const url = `https://www.xbox.com/en-US/games/browse/${slug}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      "Accept": "text/html",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`xbox ${slug} HTTP ${res.status}`);
  const html = await res.text();
  const ids = new Set<string>();
  const re = /"productId":"([A-Z0-9]{12})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) ids.add(m[1]);
  return Array.from(ids);
}

/**
 * Fetch the Xbox top-paid list (25 titles, server-side rendered HTML fallback).
 */
export async function discoverXboxTopPaid(): Promise<Array<{ bigId: string }>> {
  const ids = await fetchXboxChannelBigIds("top-paid-games");
  return ids.map(bigId => ({ bigId }));
}

interface XboxEmeraldProduct {
  productId: string;
  title?: string;
}
interface XboxEmeraldChannel {
  products?: XboxEmeraldProduct[];
  totalItems?: number;
  encodedCT?: string;
}
interface XboxEmeraldResponse {
  channels?: Record<string, XboxEmeraldChannel>;
}

/**
 * Emerald browse call — the same JSON endpoint xbox.com's client uses to
 * populate the Top-Paid channel. Returns 25 products per page plus an
 * `encodedCT` cursor for the next page. No auth required.
 *
 * Discovered via network trace on xbox.com/en-US/games/browse/top-paid-games
 * (Session 2026-09-10). Confirmed 4 sequential calls → 100 unique productIds.
 */
async function fetchXboxEmeraldPage(
  channelId: string,
  encodedCT: string | null,
): Promise<{ productIds: string[]; nextCT: string | null; totalItems: number }> {
  const body: Record<string, unknown> = {
    Filters: "e30=",
    ReturnFilters: false,
    ChannelKeyToBeUsedInResponse: `BROWSE_CHANNELID=${channelId.toUpperCase()}_FILTERS=`,
    ChannelId: channelId,
  };
  if (encodedCT) body.EncodedCT = encodedCT;
  const res = await fetch(
    "https://emerald.xboxservices.com/xboxcomfd/browse?locale=en-US",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "MS-CV": "signalpulse.0",
        "X-Ms-Api-Version": "1.1",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`xbox emerald HTTP ${res.status}`);
  const json = (await res.json()) as XboxEmeraldResponse;
  const channels = json.channels ?? {};
  const key = Object.keys(channels)[0];
  const ch = key ? channels[key] : undefined;
  const products = ch?.products ?? [];
  const productIds = products
    .map(p => p.productId)
    .filter((id): id is string => typeof id === "string" && /^[A-Z0-9]{12}$/.test(id));
  return {
    productIds,
    nextCT: ch?.encodedCT ?? null,
    totalItems: ch?.totalItems ?? 0,
  };
}

/**
 * Xbox top-100 discovery via the emerald browse JSON endpoint.
 *
 * Paginates the Top-Paid channel (25/page, ~4 calls for 100 unique productIds).
 * Falls back to whatever partial page-set succeeded on error — a partial
 * harvest still beats no harvest.
 *
 * Discovery uses the `top-paid-games` channel only.
 *
 * The `new-releases-xbox-and-xbox-360-optimized-games` channel WAS unioned in
 * here until 2026-09-11 when a probe confirmed it is dead upstream at
 * Microsoft: emerald returns totalItems=0, and xbox.com's own SSR for
 * /games/browse/new-releases embeds "title":"Failed to Get Channel". Seven
 * alternative slugs (most-played, new-releases, coming-soon, top-rated,
 * best-rated, coming-soon-games, most-popular) all returned 0. Meanwhile
 * top-paid-games already surfaces every 2026 launch we care about
 * (Battlefield 6, NBA 2K27, Blood of Dawnwalker, 007 First Light, Madden 27,
 * Onimusha — verified 49/50 top-50 productIds already in platform_sku_map),
 * so the dead union added zero value and one silent point of failure.
 *
 * TODO(xbox-new-releases-channel-replacement): monthly, probe whether Microsoft
 * has restored the channel under a different slug (or hydrates the SSR page
 * again). If a replacement surfaces, add it back as a secondary drain.
 *
 * Total addressable top-paid list is ~1001 titles per emerald's totalItems.
 */
export async function discoverXboxAll(topN: number = 100): Promise<Array<{ bigId: string }>> {
  const all: string[] = [];
  const seen = new Set<string>();

  const drainChannel = async (channelId: string, cap: number) => {
    let cursor: string | null = null;
    const maxPages = Math.ceil(cap / 25);
    for (let page = 0; page < maxPages; page++) {
      try {
        const { productIds, nextCT } = await fetchXboxEmeraldPage(channelId, cursor);
        let hadNew = false;
        for (const id of productIds) {
          if (!seen.has(id)) { seen.add(id); all.push(id); hadNew = true; }
        }
        if (!hadNew && !nextCT) break;
        if (!nextCT) break;
        cursor = nextCT;
        await new Promise(r => setTimeout(r, 250));
      } catch (e) {
        log(`xbox discovery: ${channelId} page ${page} failed: ${e instanceof Error ? e.message : e}`);
        break;
      }
    }
  };

  // Sole channel. The new-releases-* channel dropped 2026-09-11: dead upstream
  // (see doc comment above).
  await drainChannel("top-paid-games", topN);
  log(`xbox discovery: top-paid-games only (new-releases-* dropped 2026-09-11) → ${all.length} bigIds`);
  return all.map(bigId => ({ bigId }));
}

export interface XboxClassification {
  bigId: string;
  businessModel: BusinessModel;
  msrpUsdCents: number | null;
  name: string | null;
  headerImageUrl: string | null;             // Poster / SuperHeroArt from displaycatalog LocalizedProperties.
  releaseDateIso: string | null;             // Parsed OriginalReleaseDate, YYYY-MM-DD.
}

/**
 * Classify each Xbox bigId via displaycatalog. Reuses fetchXboxRatingSignal
 * because it already parses pricing in one round-trip — same call, two
 * side effects (classification + a rating snapshot we discard here).
 */
export async function classifyXboxBigIds(bigIds: string[]): Promise<XboxClassification[]> {
  const out: XboxClassification[] = [];
  for (const bigId of bigIds) {
    try {
      const r = await fetchXboxRatingSignal({ titleId: 0, bigId });
      const bm: BusinessModel = r.pricing.allSkusZero
        ? "free_to_play"
        : r.pricing.baseMsrpUsdCents == null
        ? "unknown"
        : "paid";
      out.push({
        bigId,
        businessModel: bm,
        msrpUsdCents: r.pricing.baseMsrpUsdCents,
        name: r.productTitle,
        headerImageUrl: r.storeHeaderImageUrl,
        releaseDateIso: r.storeReleaseDateIso,
      });
    } catch (e) {
      out.push({ bigId, businessModel: "unknown", msrpUsdCents: null, name: null, headerImageUrl: null, releaseDateIso: null });
      log(`xbox classify: bigId=${bigId} failed: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return out;
}

// ─── PlayStation ─────────────────────────────────────────────────────────────

/**
 * PS5 top-100 discovery via Sony's whitelisted `categoryGridRetrieve` graphql
 * op. Uses the "All PS5 Games" category (9,271 titles) sorted by 30-day sales,
 * so we get the true PSN top-100 in a single call. No auth required.
 *
 * Discovered via network trace on store.playstation.com's category grid, then
 * validated against Sony's own storefront ranking (top-10 matches GTA VI,
 * Blood of Dawnwalker, FC 27, etc). Session 2026-09-10.
 *
 * PS5 ONLY — the category itself filters out PS4-only titles. Some hybrid
 * PS4+PS5 SKUs appear (npTitleId is the PS5 SKU), which is expected.
 */
const PS5_ALL_GAMES_CATEGORY_ID = "d71e8e6d-0940-4e03-bd02-404fc7d31a31";
const PS_CATEGORY_GRID_HASH =
  "88c0b9a1273c6d320c51cd73e390924e21ae28bf09f01cde8b84b1034b16cd03";

interface PsGridProduct {
  id?: string;              // Full concept-productId, e.g. "EP1004-PPSA01547_00-GTAVIULTIMATE001".
                            // This is what productRetrieve requires — NOT npTitleId.
  npTitleId?: string;       // Middle segment only, e.g. "PPSA01547_00". Editions of
                            // the same underlying game share one npTitleId, so we use
                            // it for dedupe but never as an external_sku.
  name?: string;
  platforms?: string[];
  price?: { basePrice?: string; discountedPrice?: string; isFree?: boolean };
  webBasePrice?: string;
  storeDisplayClassification?: string;
  // Fields observed on the categoryGridRetrieve persisted-query response that
  // we opportunistically capture for the store-truthed fallback. Any absence
  // is silently tolerated — the writer just skips the fallback for that row.
  media?: Array<{ url?: string; role?: string; type?: string }>;
  releaseDate?: string;     // ISO 8601 timestamp (e.g. "2026-09-08T00:00:00Z").
}
interface PsGridResponse {
  data?: {
    categoryGridRetrieve?: {
      products?: PsGridProduct[];
      pageInfo?: { totalCount?: number };
    };
  };
  errors?: Array<{ message: string }>;
}

export interface Ps5TopProduct {
  productId: string;                             // Full concept-productId (e.g. EP1004-PPSA01547_00-GTAVIULTIMATE001).
                                                 // Required by PSN productRetrieve. Deduped by npTitleId upstream.
  npTitleId: string;                             // Kept for observability and dedupe audits.
  name: string | null;
  platforms: string[];
  storeDisplayClassification: string | null;
  msrpUsdCents: number | null;                   // Parsed from PSN grid price.basePrice under en-US locale.
                                                 // NULL when the row is F2P, subscription, or the string couldn't be parsed.
  headerImageUrl: string | null;                 // Best available cover from the grid `media` array.
  releaseDateIso: string | null;                 // Parsed ISO date, YYYY-MM-DD.
}

type PsGridSort = "sales30" | "sales7";

async function fetchPs5GridPage(offset: number, size: number, sortName: PsGridSort = "sales30"): Promise<PsGridProduct[]> {
  const variables = {
    id: PS5_ALL_GAMES_CATEGORY_ID,
    pageArgs: { size, offset },
    sortBy: { name: sortName, isAscending: false },
    filterBy: [] as string[],
    facetOptions: [] as string[],
  };
  const extensions = { persistedQuery: { version: 1, sha256Hash: PS_CATEGORY_GRID_HASH } };
  const url =
    `https://web.np.playstation.com/api/graphql/v1//op` +
    `?operationName=categoryGridRetrieve` +
    `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&extensions=${encodeURIComponent(JSON.stringify(extensions))}`;
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      // en-US pins the response to the US PSN store, which returns prices as
      // "$59.99" strings. Without this we get whatever locale the calling host's
      // egress IP maps to (£GBP from many datacenters), which breaks parsing.
      "Accept-Language": "en-US",
      "Referer": "https://store.playstation.com/en-us/",
      "x-apollo-operation-name": "categoryGridRetrieve",
      "apollo-require-preflight": "true",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    },
  });
  if (!res.ok) throw new Error(`ps categoryGridRetrieve HTTP ${res.status}`);
  const json = (await res.json()) as PsGridResponse;
  if (json.errors && json.errors.length > 0) {
    throw new Error(`ps graphql error: ${json.errors[0].message}`);
  }
  return json.data?.categoryGridRetrieve?.products ?? [];
}

/**
 * Parse the USD basePrice string returned by the PSN grid under en-US locale
 * into integer cents. Handles:
 *   "$59.99"     → 5999
 *   "US$14.99"   → 1499
 *   "Free"        → 0
 *   null/other   → null (caller decides F2P vs unknown)
 */
export function parsePs5UsdBasePriceCents(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (/^free$/i.test(s)) return 0;
  // Match a leading currency prefix that includes '$' (US$, $), then digits.dot.digits.
  const m = s.match(/^(?:US)?\$\s*(\d+)(?:\.(\d{1,2}))?$/i);
  if (!m) return null;
  const dollars = parseInt(m[1], 10);
  const cents = m[2] ? parseInt(m[2].padEnd(2, "0"), 10) : 0;
  return dollars * 100 + cents;
}

export async function discoverPs5TopSelling(topN: number = 100): Promise<Ps5TopProduct[]> {
  // Sony returns MULTIPLE ROWS per npTitleId (Standard + Deluxe + Ultimate editions
  // of the same underlying game all appear on the sales chart). We dedupe by
  // npTitleId and over-fetch until we have topN UNIQUE games.
  //
  // Discovery uses sortBy="sales30" only.
  //
  // sales7 was PART of this union until 2026-09-11 when deep probing (200-row
  // pull, saved to ps5_deep_probe.json) showed the sales7 endpoint has degraded:
  //   • 60% of the 200 rows were PS4&PS5 hybrids, 22 free titles, 3 Game Trials,
  //     2 Unavailable.
  //   • Zero of the visible 2026 chart-topping titles appeared in the sales7
  //     top-200 (NBA 2K27, GTA VI Ultimate, Wolverine Deluxe, Blood of Dawnwalker,
  //     Onimusha, Madden 27, Battlefield 6, 007 First Light, Crimson Desert).
  //   • Rows past position ~15 were alphabetically sorted, not sales-ranked.
  // Meanwhile sales30 rendered a plausible current chart (158/200 PS5-only,
  // zero F2P/Unavailable/Trial, 32 known 2026 titles, NBA 2K27 at rank 1).
  // Using sales7 as either primary or secondary poisoned dedupe: it consumed
  // slots of the topN budget with F2P/hybrid rows and pushed real sales30 top
  // hits past the cliff. Dropping sales7 recovers ~15 chart positions.
  //
  // TODO(ps5-sales7-recheck-monthly): reprobe categoryGridRetrieve?sortBy=sales7
  // once a quarter. If Sony repairs it, resurrect the union with sales7 second
  // (not first) so sales30 keeps the dedup slots.
  const pageSize = 100;
  const maxPages = Math.max(2, Math.ceil((topN * 1.3) / pageSize));
  const out: Ps5TopProduct[] = [];
  const seen = new Set<string>();

  const drainSort = async (sortName: PsGridSort) => {
    for (let page = 0; page < maxPages && out.length < topN; page++) {
      let products: PsGridProduct[];
      try {
        products = await fetchPs5GridPage(page * pageSize, pageSize, sortName);
      } catch (e) {
        log(`ps5 discovery: ${sortName} page ${page} failed: ${e instanceof Error ? e.message : e}`);
        break;
      }
      if (products.length === 0) break;

      for (const p of products) {
        // Dedupe by npTitleId (Standard/Deluxe/Ultimate editions share one),
        // but record the FULL concept-productId `p.id` as external_sku —
        // that's the value productRetrieve needs.
        const npTitleId = p.npTitleId;
        const productId = p.id;
        if (!npTitleId || !productId) continue;
        if (seen.has(npTitleId)) continue;
        // Enforce PS5-only at the row level even though the category is scoped:
        // hybrid SKUs list both platforms; require PS5 to be present.
        const platforms = Array.isArray(p.platforms) ? p.platforms : [];
        if (!platforms.includes("PS5")) continue;
        seen.add(npTitleId);
        // Pull USD MSRP from price.basePrice (populated when the caller sent
        // Accept-Language: en-US). F2P titles come back as "Free" and parse to 0;
        // paid parses to positive cents. Anything else — unavailable, add-on-only,
        // “Available with subscription” — parses to null and the writer leaves it null.
        const basePrice = (p.price && p.price.basePrice) ?? null;
        const msrpUsdCents = parsePs5UsdBasePriceCents(basePrice);
        const headerImageUrl = pickPsGridHeaderImage(p.media);
        const releaseDateIso = parsePsGridReleaseDate(p.releaseDate);
        out.push({
          productId,
          npTitleId,
          name: p.name ?? null,
          platforms,
          storeDisplayClassification: p.storeDisplayClassification ?? null,
          msrpUsdCents,
          headerImageUrl,
          releaseDateIso,
        });
        if (out.length >= topN) break;
      }
      if (out.length < topN && page < maxPages - 1) {
        await new Promise(r => setTimeout(r, 250));
      }
    }
  };

  // 30-day sales chart is the sole discovery source. sales7 dropped 2026-09-11
  // due to endpoint degradation (see comment block above).
  await drainSort("sales30");
  log(`ps5 discovery: sales30 only (sales7 dropped 2026-09-11) → ${out.length} unique npTitleIds`);
  return out;
}

/**
 * Pick the best media asset from a categoryGridRetrieve product to use as a
 * store header. Sony tags entries with role='MASTER' (main hero image) or
 * type='IMAGE'; a MASTER image beats any other; otherwise take the first
 * IMAGE url. Returns null when the row lacks a usable url.
 */
export function pickPsGridHeaderImage(media: Array<{ url?: string; role?: string; type?: string }> | undefined): string | null {
  if (!Array.isArray(media) || media.length === 0) return null;
  const master = media.find(m => m.role === "MASTER" && typeof m.url === "string" && m.url.length > 0);
  if (master?.url) return master.url;
  const anyImage = media.find(m => (m.type === "IMAGE" || m.type === undefined) && typeof m.url === "string" && m.url.length > 0);
  return anyImage?.url ?? null;
}

/**
 * Parse a PSN grid releaseDate ISO 8601 timestamp into YYYY-MM-DD. Silently
 * rejects obviously bad dates so a sentinel never lands in the store column.
 */
export function parsePsGridReleaseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return null;
  const iso = d.toISOString().slice(0, 10);
  if (iso < "1990-01-01" || iso > "2100-01-01") return null;
  return iso;
}

export interface PsClassification {
  productId: string;
  businessModel: BusinessModel;
  msrpUsdCents: number | null;
  name: string | null;
  storeDisplayClassification: string | null;
  headerImageUrl: string | null;
  releaseDateIso: string | null;
}

/**
 * Manual-seed classifier retained for callers that want to inject a curated
 * override list (e.g. Saber-relevant titles that must always appear in the
 * universe regardless of sales rank). Marked `isManualOverride` at the writer
 * layer so an automated refresh cannot clobber them.
 */
export async function classifyPsManualSeed(seeds: Array<{
  productId: string;
  businessModel: BusinessModel;
  msrpUsdCents: number | null;
  name: string | null;
}>): Promise<PsClassification[]> {
  return seeds.map(s => ({
    productId: s.productId,
    businessModel: s.businessModel,
    msrpUsdCents: s.msrpUsdCents,
    name: s.name,
    storeDisplayClassification: null,
    headerImageUrl: null,
    releaseDateIso: null,
  }));
}

/**
 * Classify discovered PS5 top-sellers. Under the persisted-query hash the
 * categoryGridRetrieve response DOES return per-SKU pricing in the SkuPrice
 * subobject when the request is pinned to en-US locale (see fetchPs5GridPage).
 * That's what we surface here: msrpUsdCents comes directly from grid data,
 * so PS5 revenue estimates no longer need a manual seed for MSRP.
 *
 * Business-model rules:
 *   1. Sony's category is scoped to "All PS5 Games" (not add-ons/subscriptions).
 *   2. Sorting by `sales30` requires paid revenue; F2P titles are rare in this
 *      list but valid and are recorded with msrpUsdCents=0 and businessModel=free_to_play.
 *   3. Anything with a parseable non-zero USD price is 'paid'.
 *   4. Anything else (msrpUsdCents=null) is left 'paid' so the row still lands
 *      in the leaderboard — revenue just falls back to unit count until an operator
 *      seeds an override.
 */
export async function classifyPs5TopSelling(rows: Ps5TopProduct[]): Promise<PsClassification[]> {
  return rows.map(r => {
    const bm: BusinessModel = r.msrpUsdCents === 0
      ? "free_to_play"
      : "paid";
    return {
      productId: r.productId,
      businessModel: bm,
      msrpUsdCents: r.msrpUsdCents,
      name: r.name,
      storeDisplayClassification: r.storeDisplayClassification,
      headerImageUrl: r.headerImageUrl,
      releaseDateIso: r.releaseDateIso,
    };
  });
}

// ─── Writer ──────────────────────────────────────────────────────────────────

interface UpsertRow {
  platform: ConsolePlatform;
  externalSku: string;
  titleId: number;                           // caller supplies (from products table lookup or dedup)
  conceptId: string | null;
  skuRole: string;                           // typically "base"
  businessModel: BusinessModel;
  msrpUsdCents: number | null;
  businessModelSource: string;               // e.g. "steam_appdetails.is_free"
  isManualOverride?: boolean;
}

/**
 * Upsert into platform_sku_map. Preserves is_manual_override=true rows from
 * being clobbered by an automated refresh — the ON CONFLICT clause skips them.
 *
 * IMPORTANT: title_id is IMMUTABLE once written. On conflict we DO NOT set
 * title_id = excluded.title_id, because store_rating_signal_daily,
 * steam_review_history, and every joined report keys off title_id. If the id
 * drifts, historical rows orphan (rating trends flatline, leaderboards lose
 * back-history) and cross-title contamination becomes possible when a fresh
 * discovery allocator hands out a number that used to belong to a different
 * SKU. The DB row's title_id is the source of truth from the moment it
 * first lands; the caller's `titleIdFor` value is only consulted on INSERT.
 */
export function upsertSkuMap(rows: UpsertRow[]): { inserted: number; updated: number; preservedOverride: number } {
  const nowIso = new Date().toISOString();
  const insertStmt = rawSqlite.prepare(
    `INSERT INTO platform_sku_map
       (title_id, platform, external_sku, concept_id, sku_role,
        business_model, msrp_usd_cents, business_model_source, is_manual_override,
        refreshed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, external_sku) DO UPDATE SET
       -- title_id intentionally omitted: pin existing row's title_id forever.
       concept_id = excluded.concept_id,
       sku_role = excluded.sku_role,
       business_model = CASE WHEN platform_sku_map.is_manual_override = 1
                             THEN platform_sku_map.business_model
                             ELSE excluded.business_model END,
       -- Keep the existing value whenever the incoming row is null, so a
       -- classifier that couldn't determine price never wipes a known MSRP.
       -- Manual overrides still take precedence over any refresh.
       msrp_usd_cents = CASE WHEN platform_sku_map.is_manual_override = 1
                             THEN platform_sku_map.msrp_usd_cents
                             ELSE COALESCE(excluded.msrp_usd_cents, platform_sku_map.msrp_usd_cents) END,
       business_model_source = CASE WHEN platform_sku_map.is_manual_override = 1
                             THEN platform_sku_map.business_model_source
                             ELSE excluded.business_model_source END,
       refreshed_at = excluded.refreshed_at
       WHERE platform_sku_map.is_manual_override = 0 OR excluded.is_manual_override = 1`
  );
  const preOverrideStmt = rawSqlite.prepare(
    `SELECT is_manual_override FROM platform_sku_map WHERE platform = ? AND external_sku = ?`
  );
  const existsStmt = rawSqlite.prepare(
    `SELECT 1 FROM platform_sku_map WHERE platform = ? AND external_sku = ?`
  );

  // Hard invariant enforcement (2026-09-12): reject F2P at the write boundary.
  // Caller-side filter in runFullDiscovery is the primary defense; this is a
  // belt-and-suspenders check so no future caller can silently reintroduce
  // the class of bug that caused the 2026-09-11 title_id collisions.
  // Manual overrides are exempt — they are explicit human decisions.
  const f2pRejected = rows.filter(r => r.businessModel === "free_to_play" && !r.isManualOverride);
  if (f2pRejected.length > 0) {
    const sample = f2pRejected.slice(0, 3).map(r => `${r.platform}:${r.externalSku}`).join(", ");
    throw new Error(`upsertSkuMap: refusing to write ${f2pRejected.length} free_to_play row(s) (paid-only leaderboard invariant). Sample: ${sample}`);
  }

  let inserted = 0, updated = 0, preservedOverride = 0;
  const runTx = rawSqlite.transaction((batch: UpsertRow[]) => {
    for (const r of batch) {
      const pre = preOverrideStmt.get(r.platform, r.externalSku) as { is_manual_override: number } | undefined;
      const existed = !!existsStmt.get(r.platform, r.externalSku);
      if (pre?.is_manual_override === 1 && !r.isManualOverride) {
        preservedOverride++;
        continue;
      }
      insertStmt.run(
        r.titleId, r.platform, r.externalSku, r.conceptId, r.skuRole,
        r.businessModel, r.msrpUsdCents, r.businessModelSource,
        r.isManualOverride ? 1 : 0, nowIso, nowIso,
      );
      if (existed) updated++; else inserted++;
    }
  });
  runTx(rows);
  return { inserted, updated, preservedOverride };
}

// ─── Console title name bootstrap ────────────────────────────────────────────

/**
 * Insert storefront-known title names + header art into console_title_igdb so
 * the leaderboard displays a readable title from day one — before any IGDB
 * match lands — AND so we always have a store-truthed fallback when IGDB
 * later mis-matches.
 *
 * Two-column strategy:
 *   - `name` / `cover_url` are the DISPLAY fields that IGDB writes to. On
 *     conflict they only accept the store name when there's no IGDB match
 *     yet (backwards-compatible with the old behaviour).
 *   - `store_name` / `store_header_image_url` are TRUTH-FROM-THE-STORE fields.
 *     They are always kept up to date on refresh ("the store still calls this
 *     Halloween: The Game") and are NEVER touched by the IGDB refresh path.
 *     The leaderboard route falls back to them whenever match_confidence='low'
 *     or IGDB has no data.
 *
 *   This lets us keep IGDB's canonical names for well-matched titles while
 *   still recovering the correct name for the ones where IGDB attached the
 *   wrong game (e.g. Steam appid 3219630 = "Halloween: The Game" but IGDB
 *   returned "Solitaire Game Halloween 2").
 */
export function bootstrapConsoleTitleNames(
  rows: Array<{ titleId: number; name: string; headerImageUrl?: string | null; releaseDateIso?: string | null }>,
): { inserted: number; updatedName: number; kept: number } {
  if (rows.length === 0) return { inserted: 0, updatedName: 0, kept: 0 };
  const nowIso = new Date().toISOString();
  // Insert-if-missing; else update `name` only when IGDB hasn't taken over,
  // but ALWAYS refresh store_name / store_header_image_url / store_release_date
  // so the fallback stays in sync with what the storefront currently says.
  const stmt = rawSqlite.prepare(`
    INSERT INTO console_title_igdb (title_id, name, store_name, store_header_image_url, store_release_date, refreshed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(title_id) DO UPDATE SET
      name = CASE WHEN console_title_igdb.igdb_id IS NULL
                  THEN excluded.name
                  ELSE console_title_igdb.name END,
      store_name = excluded.store_name,
      -- Only overwrite each store column when we actually have a value this
      -- call; otherwise keep whatever was previously captured. That way a
      -- Steam-then-Xbox refresh sequence doesn't wipe out the Xbox art with a
      -- later Steam call that couldn't fetch headers.
      store_header_image_url = COALESCE(excluded.store_header_image_url, console_title_igdb.store_header_image_url),
      store_release_date = COALESCE(excluded.store_release_date, console_title_igdb.store_release_date)
  `);
  const existsStmt = rawSqlite.prepare(`SELECT igdb_id, name FROM console_title_igdb WHERE title_id = ?`);

  let inserted = 0, updatedName = 0, kept = 0;
  const runTx = rawSqlite.transaction((batch: typeof rows) => {
    for (const r of batch) {
      const existing = existsStmt.get(r.titleId) as { igdb_id: number | null; name: string | null } | undefined;
      stmt.run(r.titleId, r.name, r.name, r.headerImageUrl ?? null, r.releaseDateIso ?? null, nowIso, nowIso);
      if (!existing) inserted++;
      else if (existing.igdb_id != null) kept++;
      else updatedName++;
    }
  });
  // Deduplicate by titleId first — a title in multiple platforms would
  // otherwise be written N times inside one transaction.
  const seen = new Set<number>();
  const deduped = rows.filter(r => (seen.has(r.titleId) ? false : (seen.add(r.titleId), true)));
  runTx(deduped);
  return { inserted, updatedName, kept };
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export interface DiscoveryResult {
  startedAt: string;
  completedAt: string;
  steam: { discovered: number; classified: number; paid: number; f2p: number; unknown: number; written: number };
  xbox: { discovered: number; classified: number; paid: number; f2p: number; unknown: number; written: number };
  ps: { discovered: number; classified: number; paid: number; f2p: number; unknown: number; written: number };
}

/**
 * Full discovery run for a fresh universe refresh.
 *
 * PS5 flow (2026-09-10):
 *   - `discoverPs5TopSelling()` pulls the top-100 PS5 titles by 30-day sales
 *     from Sony's whitelisted `categoryGridRetrieve` op — no manual seeding
 *     required for baseline coverage.
 *   - `psManualSeeds` remains available as an ADDITIVE override channel for
 *     titles that must always be in the universe (e.g. Saber-relevant SKUs).
 *     Seeded rows carry isManualOverride=true so auto-refresh cannot clobber
 *     them; they merge with the discovered set and dedupe on productId.
 *
 * `titleIdFor` is a caller-supplied fn that returns a stable title_id for a
 * (platform, externalSku, name) — dedupes titles that appear on multiple stores.
 */
export async function runFullDiscovery(opts: {
  steamPages?: number;
  ps5TopN?: number;
  psManualSeeds?: Array<{ productId: string; businessModel: BusinessModel; msrpUsdCents: number | null; name: string | null }>;
  titleIdFor: (platform: ConsolePlatform, sku: string, name: string | null) => number;
}): Promise<DiscoveryResult> {
  const startedAt = new Date().toISOString();
  const manualSeeds = opts.psManualSeeds ?? [];

  // Run all three discoveries in parallel; classification serially per platform (rate-limit friendly).
  const [steamRaw, xboxRaw, ps5Raw] = await Promise.all([
    discoverSteamTopSellers(opts.steamPages ?? 2),
    discoverXboxAll(),
    discoverPs5TopSelling(opts.ps5TopN ?? 100),
  ]);

  const [steamCls, xboxCls, ps5DiscoveredCls, psManualCls] = await Promise.all([
    classifySteamAppIds(steamRaw.map(x => x.appId)),
    classifyXboxBigIds(xboxRaw.map(x => x.bigId)),
    classifyPs5TopSelling(ps5Raw),
    classifyPsManualSeed(manualSeeds),
  ]);

  // Write to platform_sku_map.
  //
  // HARD INVARIANT (2026-09-12): F2P classifications are DROPPED before write.
  // The system is a paid-titles leaderboard end-to-end — the leaderboard
  // route filters `business_model='paid'` at render, so F2P rows are already
  // invisible to users. But keeping them in platform_sku_map caused the
  // 2026-09-11 collision incident: Microsoft's "top-paid-games" channel
  // returns F2P grossers (Fortnite, Roblox, Apex, etc.) at real positions.
  // Discovery burned title_ids on those SKUs; a later run at a different
  // moment saw genuinely-paid titles at those same positions and — with the
  // stale-counter allocator — minted colliding title_ids. Stopping F2P at
  // the write boundary eliminates the entire class of problem.
  //
  // `unknown` classifications ARE kept: they self-heal on the next run's
  // ON CONFLICT update if the classifier recovers, whereas deleting them
  // would lose the SKU until it re-appears in top-sellers.
  const dropF2p = <T extends { businessModel: BusinessModel }>(rows: T[], platform: string) => {
    const kept = rows.filter(r => r.businessModel !== "free_to_play");
    const dropped = rows.length - kept.length;
    if (dropped > 0) log(`${platform} discovery: dropped ${dropped} free_to_play row(s) before upsert (paid-only leaderboard invariant)`);
    return kept;
  };

  const steamPaid = dropF2p(steamCls, "steam");
  const xboxPaid  = dropF2p(xboxCls, "xbox");
  const ps5Paid   = dropF2p(ps5DiscoveredCls, "ps5");

  const steamRows: UpsertRow[] = steamPaid.map(c => ({
    platform: "steam", externalSku: c.appId, titleId: opts.titleIdFor("steam", c.appId, c.name),
    conceptId: null, skuRole: "base",
    businessModel: c.businessModel, msrpUsdCents: c.msrpUsdCents,
    businessModelSource: `steam_appdetails.is_free=${c.businessModel === "free_to_play"};type=${c.type ?? "?"}`,
  }));
  const xboxRows: UpsertRow[] = xboxPaid.map(c => ({
    platform: "xbox", externalSku: c.bigId, titleId: opts.titleIdFor("xbox", c.bigId, c.name),
    conceptId: null, skuRole: "base",
    businessModel: c.businessModel, msrpUsdCents: c.msrpUsdCents,
    businessModelSource: `xbox_displaycatalog.MSRP`,
  }));
  const ps5DiscoveredRows: UpsertRow[] = ps5Paid.map(c => ({
    platform: "ps5", externalSku: c.productId,
    // Remap known duplicate SKUs onto their base title_id so discovery never
    // re-creates a rival row for the same game. See SKU_BASE_TITLE_ID above.
    titleId: remapTitleId("ps5", c.productId, opts.titleIdFor("ps5", c.productId, c.name)),
    conceptId: null, skuRole: "base",
    businessModel: c.businessModel, msrpUsdCents: c.msrpUsdCents,
    businessModelSource: `ps_categoryGridRetrieve.sales30`,
  }));
  const psManualRows: UpsertRow[] = psManualCls.map(c => ({
    platform: "ps5", externalSku: c.productId,
    titleId: remapTitleId("ps5", c.productId, opts.titleIdFor("ps5", c.productId, c.name)),
    conceptId: null, skuRole: "base",
    businessModel: c.businessModel, msrpUsdCents: c.msrpUsdCents,
    businessModelSource: `ps_manual_seed`,
    isManualOverride: true,
  }));

  const steamW = upsertSkuMap(steamRows);
  const xboxW = upsertSkuMap(xboxRows);
  // Auto-discovered PS5 rows first, then manual overrides so a manual entry
  // for the same productId wins (writer preserves is_manual_override=true).
  const psAutoW = upsertSkuMap(ps5DiscoveredRows);
  const psManualW = upsertSkuMap(psManualRows);

  // ── Storefront rank snapshot (Push 2, Change 11) ────────────────────────────
  // Record today's rank for each (platform, sort_key). Position in the source
  // arrays IS the rank because both `discoverXboxAll` and `discoverPs5TopSelling`
  // return arrays already ordered by the storefront (top-paid-games, sales30).
  // Classification preserves that order 1:1, so `xboxRows[i]` and
  // `ps5DiscoveredRows[i]` are at rank i+1. Manual seeds are NOT ranked — they
  // are additive coverage, not a sales-ranked chart.
  //
  // Rank writes are best-effort: a failure here must not break discovery
  // (leaderboards still work without a snapshot; only churn / hot-badge do).
  try {
    const xboxRankEntries = xboxRows.map((r, i) => ({ titleId: r.titleId, rank: i + 1 }));
    if (xboxRankEntries.length > 0) {
      writeRankSnapshot("xbox", "xbox_api_top_paid", xboxRankEntries);
    }
    const ps5RankEntries = ps5DiscoveredRows.map((r, i) => ({ titleId: r.titleId, rank: i + 1 }));
    if (ps5RankEntries.length > 0) {
      writeRankSnapshot("ps5", "psn_api_sales30", ps5RankEntries);
    }
  } catch (e: any) {
    log(`rank snapshot write failed (non-fatal): ${e?.message ?? String(e)}`);
  }

  // Emit top-50 churn metric per (platform, sort_key). Null on the first-ever
  // run (no yesterday baseline) is logged and skipped; once 2+ days of history
  // exist the metric drives the daily→weekly relaxation decision. Not
  // acceptance-tested against thresholds here — that's an operator call after
  // 14 days of empirical data.
  try {
    for (const [platform, sortKey] of [
      ["xbox", "xbox_api_top_paid"],
      ["ps5", "psn_api_sales30"],
    ] as const) {
      const c = computeTop50Churn(platform, sortKey);
      if (c.churnPct != null) {
        log(`top50_churn platform=${platform} sort_key=${sortKey} churn_pct=${c.churnPct.toFixed(1)} entered=${c.enteredCount} exited=${c.exitedCount} today_n=${c.todayN} yesterday_n=${c.yesterdayN}`);
      } else {
        log(`top50_churn platform=${platform} sort_key=${sortKey} churn_pct=null (today_n=${c.todayN} yesterday_n=${c.yesterdayN})`);
      }
    }
  } catch (e: any) {
    log(`top50_churn compute failed (non-fatal): ${e?.message ?? String(e)}`);
  }

  // Bootstrap console_title_igdb with the storefront-fetched name, header art,
  // and release date so the leaderboard has SOMETHING readable and a durable
  // store-truthed fallback even before IGDB enrichment runs. Only the display
  // `name` column is gated by igdb_id being null; store_* columns always
  // refresh so the fallback stays current with the storefront.
  const nameRows: Array<{ titleId: number; name: string; headerImageUrl?: string | null; releaseDateIso?: string | null }> = [];
  for (const c of steamCls) if (c.name) nameRows.push({
    titleId: opts.titleIdFor("steam", c.appId, c.name),
    name: c.name,
    headerImageUrl: c.headerImageUrl,
    releaseDateIso: c.releaseDateIso,
  });
  for (const c of xboxCls) if (c.name) nameRows.push({
    titleId: opts.titleIdFor("xbox", c.bigId, c.name),
    name: c.name,
    headerImageUrl: c.headerImageUrl,
    releaseDateIso: c.releaseDateIso,
  });
  for (const c of ps5DiscoveredCls) if (c.name) {
    // Skip name bootstrap for remapped SKUs so the base title's clean name
    // is never overwritten by the region-variant's storefront edition name
    // (e.g. "Resident Evil Requiem: Deluxe Edition" clobbering "Resident
    // Evil Requiem" on 10335).
    if (SKU_BASE_TITLE_ID.has(`ps5:${c.productId}`)) continue;
    nameRows.push({
      titleId: opts.titleIdFor("ps5", c.productId, c.name),
      name: c.name,
      headerImageUrl: c.headerImageUrl,
      releaseDateIso: c.releaseDateIso,
    });
  }
  for (const c of psManualCls) if (c.name) {
    if (SKU_BASE_TITLE_ID.has(`ps5:${c.productId}`)) continue;
    nameRows.push({
      titleId: opts.titleIdFor("ps5", c.productId, c.name),
      name: c.name,
      headerImageUrl: c.headerImageUrl,
      releaseDateIso: c.releaseDateIso,
    });
  }
  bootstrapConsoleTitleNames(nameRows);

  // Self-heal pass for Xbox title_ids stuck without a console_title_igdb row.
  //
  // classifyXboxBigIds catches every displaycatalog failure and yields
  // { name: null }, which the loops above skip. If displaycatalog was
  // unhealthy for a given bigId when discovery first met it, no cti row
  // was ever inserted for its title_id. On the leaderboard the LEFT JOIN
  // into cti then returns NULL and the client falls back to displaying
  // the raw title_id (e.g. "10287").
  //
  // Prior daily runs never revisited those pre-existing bigIds because
  // classify+bootstrap only ran against that day's discovery batch. Fix:
  // enumerate Xbox platform_sku_map rows that still have no cti row and
  // take one retry pass. Capped so a truly-retired-bigId cohort can't turn
  // the daily discovery into an O(N) call storm.
  try {
    const XBOX_SELF_HEAL_MAX = 100;
    const missingRows = rawSqlite.prepare(`
      SELECT psm.title_id AS title_id, psm.external_sku AS big_id
      FROM platform_sku_map psm
      LEFT JOIN console_title_igdb cti ON cti.title_id = psm.title_id
      WHERE psm.platform = 'xbox'
        AND cti.title_id IS NULL
      ORDER BY psm.title_id DESC
      LIMIT ?
    `).all(XBOX_SELF_HEAL_MAX) as Array<{ title_id: number; big_id: string }>;

    if (missingRows.length > 0) {
      log(`xbox self-heal: retrying ${missingRows.length} title_ids with no console_title_igdb row (cap ${XBOX_SELF_HEAL_MAX})`);
      const retryRows: Array<{ titleId: number; name: string; headerImageUrl?: string | null; releaseDateIso?: string | null }> = [];
      let recovered = 0;
      let stillFailed = 0;
      for (const m of missingRows) {
        try {
          const r = await fetchXboxRatingSignal({ titleId: m.title_id, bigId: m.big_id });
          if (r.productTitle && r.productTitle.trim().length > 0) {
            retryRows.push({
              titleId: m.title_id,
              name: r.productTitle.trim(),
              headerImageUrl: r.storeHeaderImageUrl ?? null,
              releaseDateIso: r.storeReleaseDateIso ?? null,
            });
            recovered++;
          } else {
            stillFailed++;
          }
        } catch {
          stillFailed++;
        }
        await new Promise(r => setTimeout(r, 250));
      }
      if (retryRows.length > 0) {
        const heal = bootstrapConsoleTitleNames(retryRows);
        log(`xbox self-heal: recovered=${recovered} still_failed=${stillFailed} inserted=${heal.inserted} kept=${heal.kept}`);
      } else {
        log(`xbox self-heal: recovered=0 still_failed=${stillFailed} — displaycatalog still unavailable for these bigIds`);
      }
    }
  } catch (e) {
    // Self-heal is best-effort; never fail the whole discovery because of it.
    log(`xbox self-heal: pass failed: ${e instanceof Error ? e.message : e}`);
  }

  // Aggregate PS stats across auto + manual (dedupe by productId for accurate
  // discovered/paid counts).
  const psAll = new Map<string, PsClassification>();
  for (const c of ps5DiscoveredCls) psAll.set(c.productId, c);
  for (const c of psManualCls) psAll.set(c.productId, c);
  const psMerged = Array.from(psAll.values());

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    steam: {
      discovered: steamRaw.length, classified: steamCls.length,
      paid: steamCls.filter(c => c.businessModel === "paid").length,
      f2p: steamCls.filter(c => c.businessModel === "free_to_play").length,
      unknown: steamCls.filter(c => c.businessModel === "unknown").length,
      written: steamW.inserted + steamW.updated,
    },
    xbox: {
      discovered: xboxRaw.length, classified: xboxCls.length,
      paid: xboxCls.filter(c => c.businessModel === "paid").length,
      f2p: xboxCls.filter(c => c.businessModel === "free_to_play").length,
      unknown: xboxCls.filter(c => c.businessModel === "unknown").length,
      written: xboxW.inserted + xboxW.updated,
    },
    ps: {
      discovered: ps5Raw.length + manualSeeds.length,
      classified: psMerged.length,
      paid: psMerged.filter(c => c.businessModel === "paid").length,
      f2p: psMerged.filter(c => c.businessModel === "free_to_play").length,
      unknown: psMerged.filter(c => c.businessModel === "unknown").length,
      written: psAutoW.inserted + psAutoW.updated + psManualW.inserted + psManualW.updated,
    },
  };
}

/** Utility used by the verification script and future refresh cron. */
export function todayUtcDate(): string {
  return todayUtc();
}
