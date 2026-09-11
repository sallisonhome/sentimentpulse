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
    };
  };
}

/**
 * Fetch the Steam top-sellers list. `hidef2p=1` filters F2P at the SOURCE
 * (defense in depth on top of the ingest gate).
 */
export async function discoverSteamTopSellers(pages: number = 4): Promise<Array<{ appId: string }>> {
  const out: Array<{ appId: string }> = [];
  const seen = new Set<string>();
  for (let page = 0; page < pages; page++) {
    const start = page * 25;
    const url = `https://store.steampowered.com/search/results/?query=&start=${start}&count=25&filter=topsellers&supportedlang=english&category1=998&hidef2p=1&infinite=1`;
    let resp: SteamSearchResponse;
    try {
      resp = await fetchJson<SteamSearchResponse>(url, { timeoutMs: 15000 });
    } catch (e) {
      log(`steam discovery: page ${page} failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const appIds = extractSteamAppIds(resp.results_html || "");
    for (const id of appIds) {
      if (!seen.has(id)) { seen.add(id); out.push({ appId: id }); }
    }
    await new Promise(r => setTimeout(r, 300));
  }
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
}

export async function classifySteamAppIds(appIds: string[]): Promise<SteamClassification[]> {
  const out: SteamClassification[] = [];
  // appdetails supports batch via comma-separated appids but returns partial data;
  // one-at-a-time is more reliable and Valve rate-limits leniently.
  for (const id of appIds) {
    const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(id)}&cc=us&l=english&filters=basic,price_overview`;
    try {
      const resp = await fetchJson<SteamAppDetailsResponse>(url, { timeoutMs: 15000 });
      const entry = resp[id];
      if (!entry || !entry.success || !entry.data) {
        out.push({ appId: id, businessModel: "unknown", msrpUsdCents: null, name: null, type: null });
        continue;
      }
      const d = entry.data;
      if (d.type !== "game") {
        // Non-game (DLC, demo, video, application) — do not classify as paid.
        out.push({ appId: id, businessModel: "unknown", msrpUsdCents: null, name: d.name, type: d.type });
        continue;
      }
      if (d.is_free === true) {
        out.push({ appId: id, businessModel: "free_to_play", msrpUsdCents: 0, name: d.name, type: d.type });
        continue;
      }
      // Paid game.
      const cents = d.price_overview?.initial ?? null;   // Steam returns integer cents already
      out.push({ appId: id, businessModel: "paid", msrpUsdCents: cents, name: d.name, type: d.type });
    } catch (e) {
      out.push({ appId: id, businessModel: "unknown", msrpUsdCents: null, name: null, type: null });
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
 * Total addressable top-paid list is ~1001 titles per emerald's totalItems.
 */
export async function discoverXboxAll(topN: number = 100): Promise<Array<{ bigId: string }>> {
  const channelId = "top-paid-games";
  const all: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  const maxPages = Math.ceil(topN / 25);
  for (let page = 0; page < maxPages; page++) {
    try {
      const { productIds, nextCT } = await fetchXboxEmeraldPage(channelId, cursor);
      for (const id of productIds) {
        if (!seen.has(id)) { seen.add(id); all.push(id); }
        if (all.length >= topN) break;
      }
      if (all.length >= topN || !nextCT) break;
      cursor = nextCT;
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      log(`xbox discovery: emerald page ${page} failed: ${e instanceof Error ? e.message : e}`);
      break;
    }
  }
  return all.slice(0, topN).map(bigId => ({ bigId }));
}

export interface XboxClassification {
  bigId: string;
  businessModel: BusinessModel;
  msrpUsdCents: number | null;
  name: string | null;
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
      out.push({ bigId, businessModel: bm, msrpUsdCents: r.pricing.baseMsrpUsdCents, name: r.productTitle });
    } catch (e) {
      out.push({ bigId, businessModel: "unknown", msrpUsdCents: null, name: null });
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
}

async function fetchPs5GridPage(offset: number, size: number): Promise<PsGridProduct[]> {
  const variables = {
    id: PS5_ALL_GAMES_CATEGORY_ID,
    pageArgs: { size, offset },
    sortBy: { name: "sales30", isAscending: false },
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
  // npTitleId and over-fetch until we have topN UNIQUE games. Observed collapse
  // ratio is ~0.79 (79 uniques per 100 rows), so 2 pages cover top-100 easily.
  const pageSize = 100;
  const maxPages = Math.max(2, Math.ceil((topN * 1.3) / pageSize));
  const out: Ps5TopProduct[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < maxPages && out.length < topN; page++) {
    let products: PsGridProduct[];
    try {
      products = await fetchPs5GridPage(page * pageSize, pageSize);
    } catch (e) {
      log(`ps5 discovery: page ${page} failed: ${e instanceof Error ? e.message : e}`);
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
      out.push({
        productId,
        npTitleId,
        name: p.name ?? null,
        platforms,
        storeDisplayClassification: p.storeDisplayClassification ?? null,
        msrpUsdCents,
      });
      if (out.length >= topN) break;
    }
    if (out.length < topN && page < maxPages - 1) {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  return out;
}

export interface PsClassification {
  productId: string;
  businessModel: BusinessModel;
  msrpUsdCents: number | null;
  name: string | null;
  storeDisplayClassification: string | null;
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
 * Insert storefront-known title names into console_title_igdb so the leaderboard
 * displays a readable title from day one — before any IGDB match lands.
 *
 * On conflict, only writes name when igdb_id IS NULL. A row that already has
 * a real IGDB match keeps whatever name IGDB gave it — never regresses to the
 * storefront's crude name (e.g. Xbox's product-catalog titles are often ugly).
 */
export function bootstrapConsoleTitleNames(rows: Array<{ titleId: number; name: string }>): { inserted: number; updatedName: number; kept: number } {
  if (rows.length === 0) return { inserted: 0, updatedName: 0, kept: 0 };
  const nowIso = new Date().toISOString();
  // Insert-if-missing; else update name only when we haven't matched IGDB yet.
  const stmt = rawSqlite.prepare(`
    INSERT INTO console_title_igdb (title_id, name, refreshed_at, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(title_id) DO UPDATE SET
      name = CASE WHEN console_title_igdb.igdb_id IS NULL
                  THEN excluded.name
                  ELSE console_title_igdb.name END
  `);
  const existsStmt = rawSqlite.prepare(`SELECT igdb_id, name FROM console_title_igdb WHERE title_id = ?`);

  let inserted = 0, updatedName = 0, kept = 0;
  const runTx = rawSqlite.transaction((batch: typeof rows) => {
    for (const r of batch) {
      const existing = existsStmt.get(r.titleId) as { igdb_id: number | null; name: string | null } | undefined;
      stmt.run(r.titleId, r.name, nowIso, nowIso);
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

  // Write to platform_sku_map
  const steamRows: UpsertRow[] = steamCls.map(c => ({
    platform: "steam", externalSku: c.appId, titleId: opts.titleIdFor("steam", c.appId, c.name),
    conceptId: null, skuRole: "base",
    businessModel: c.businessModel, msrpUsdCents: c.msrpUsdCents,
    businessModelSource: `steam_appdetails.is_free=${c.businessModel === "free_to_play"};type=${c.type ?? "?"}`,
  }));
  const xboxRows: UpsertRow[] = xboxCls.map(c => ({
    platform: "xbox", externalSku: c.bigId, titleId: opts.titleIdFor("xbox", c.bigId, c.name),
    conceptId: null, skuRole: "base",
    businessModel: c.businessModel, msrpUsdCents: c.msrpUsdCents,
    businessModelSource: `xbox_displaycatalog.MSRP`,
  }));
  const ps5DiscoveredRows: UpsertRow[] = ps5DiscoveredCls.map(c => ({
    platform: "ps5", externalSku: c.productId, titleId: opts.titleIdFor("ps5", c.productId, c.name),
    conceptId: null, skuRole: "base",
    businessModel: c.businessModel, msrpUsdCents: c.msrpUsdCents,
    businessModelSource: `ps_categoryGridRetrieve.sales30`,
  }));
  const psManualRows: UpsertRow[] = psManualCls.map(c => ({
    platform: "ps5", externalSku: c.productId, titleId: opts.titleIdFor("ps5", c.productId, c.name),
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

  // Bootstrap console_title_igdb with the storefront-fetched name so the
  // leaderboard has SOMETHING readable even before IGDB enrichment runs.
  // Only writes when the row is new or when igdb_id IS NULL (so a real IGDB
  // refresh that filled slug/cover_url is never clobbered by a raw storefront
  // name later).
  const nameRows: Array<{ titleId: number; name: string }> = [];
  for (const c of steamCls) if (c.name) nameRows.push({ titleId: opts.titleIdFor("steam", c.appId, c.name), name: c.name });
  for (const c of xboxCls)  if (c.name) nameRows.push({ titleId: opts.titleIdFor("xbox",  c.bigId,  c.name), name: c.name });
  for (const c of ps5DiscoveredCls) if (c.name) nameRows.push({ titleId: opts.titleIdFor("ps5", c.productId, c.name), name: c.name });
  for (const c of psManualCls)      if (c.name) nameRows.push({ titleId: opts.titleIdFor("ps5", c.productId, c.name), name: c.name });
  bootstrapConsoleTitleNames(nameRows);

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
