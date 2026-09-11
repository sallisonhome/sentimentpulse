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
 * Fetch the Xbox top-paid list (25 titles, server-side rendered).
 */
export async function discoverXboxTopPaid(): Promise<Array<{ bigId: string }>> {
  const ids = await fetchXboxChannelBigIds("top-paid-games");
  return ids.map(bigId => ({ bigId }));
}

/**
 * Broader Xbox discovery: merges every Xbox browse channel we've validated
 * as returning bigIds. Each page returns 25 unique ids; deduped across all
 * pages we typically get 45–65 unique premium candidates. Falls back to
 * whatever succeeded if any single channel errors — a partial harvest still
 * beats no harvest.
 *
 * NOTE: Xbox's server-side listings cap at 25 per page and page-index params
 * are ignored, so this is the current ceiling without headless browser scroll.
 * Total addressable top-paid list is ~1001 titles per xbox.com's totalItems.
 */
export async function discoverXboxAll(): Promise<Array<{ bigId: string }>> {
  const channels = ["top-paid-games", "popular"];
  const all = new Set<string>();
  for (const c of channels) {
    try {
      const ids = await fetchXboxChannelBigIds(c);
      for (const id of ids) all.add(id);
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      log(`xbox discovery: channel '${c}' failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return Array.from(all).map(bigId => ({ bigId }));
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
 * PS v1 discovery is a MANUAL SEED — Sony's storefront GraphQL for category
 * listings is whitelist-gated on hash and we did not spend Phase 3 budget
 * chasing whitelisted category ops. Instead, callers provide a curated list
 * of PS product IDs (from Saber-relevant titles and known premium chart entries),
 * and classification runs against them the same way Xbox does — using the
 * productRetrieve GraphQL which we already validated works.
 *
 * Tracked in todo.md Phase 3.5 as follow-up: replace manual seed with a real
 * top-charts crawl once we identify a whitelisted category-listing hash.
 */
export interface PsClassification {
  productId: string;
  businessModel: BusinessModel;
  msrpUsdCents: number | null;
  name: string | null;
  storeDisplayClassification: string | null;
}

/**
 * PS classification via productRetrieve GraphQL. Uses the star-rating hash
 * we already have; the response also includes storeDisplayClassification and
 * a webctas array. We treat FULL_GAME + non-zero webcta price as `paid`,
 * FULL_GAME + all-zero webcta as `free_to_play`, everything else as `unknown`.
 *
 * NOTE: the wcaProductStarRatingRetrive query returns star-rating only — no
 * webctas. For v1, PS classification is manual-seed-based and callers pass
 * businessModel explicitly. This function exists as a hook for the future
 * whitelisted product-detail hash.
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
       title_id = excluded.title_id,
       concept_id = excluded.concept_id,
       sku_role = excluded.sku_role,
       business_model = CASE WHEN platform_sku_map.is_manual_override = 1
                             THEN platform_sku_map.business_model
                             ELSE excluded.business_model END,
       msrp_usd_cents = CASE WHEN platform_sku_map.is_manual_override = 1
                             THEN platform_sku_map.msrp_usd_cents
                             ELSE excluded.msrp_usd_cents END,
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
 * `psManualSeeds` is required until PS crawler ships (Phase 3.5).
 * `titleIdFor` is a caller-supplied fn that returns a stable title_id for a
 * (platform, externalSku, name) — dedupes titles that appear on multiple stores.
 */
export async function runFullDiscovery(opts: {
  steamPages?: number;
  psManualSeeds: Array<{ productId: string; businessModel: BusinessModel; msrpUsdCents: number | null; name: string | null }>;
  titleIdFor: (platform: ConsolePlatform, sku: string, name: string | null) => number;
}): Promise<DiscoveryResult> {
  const startedAt = new Date().toISOString();

  // Run all three discoveries in parallel; classification serially per platform (rate-limit friendly).
  const [steamRaw, xboxRaw] = await Promise.all([
    discoverSteamTopSellers(opts.steamPages ?? 2),
    discoverXboxAll(),
  ]);

  const [steamCls, xboxCls, psCls] = await Promise.all([
    classifySteamAppIds(steamRaw.map(x => x.appId)),
    classifyXboxBigIds(xboxRaw.map(x => x.bigId)),
    classifyPsManualSeed(opts.psManualSeeds),
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
  const psRows: UpsertRow[] = psCls.map(c => ({
    platform: "ps5", externalSku: c.productId, titleId: opts.titleIdFor("ps5", c.productId, c.name),
    conceptId: null, skuRole: "base",
    businessModel: c.businessModel, msrpUsdCents: c.msrpUsdCents,
    businessModelSource: `ps_manual_seed`,
    isManualOverride: true,                  // manual seeds are protected from auto-refresh
  }));

  const steamW = upsertSkuMap(steamRows);
  const xboxW = upsertSkuMap(xboxRows);
  const psW = upsertSkuMap(psRows);

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
      discovered: opts.psManualSeeds.length, classified: psCls.length,
      paid: psCls.filter(c => c.businessModel === "paid").length,
      f2p: psCls.filter(c => c.businessModel === "free_to_play").length,
      unknown: psCls.filter(c => c.businessModel === "unknown").length,
      written: psW.inserted + psW.updated,
    },
  };
}

/** Utility used by the verification script and future refresh cron. */
export function todayUtcDate(): string {
  return todayUtc();
}
