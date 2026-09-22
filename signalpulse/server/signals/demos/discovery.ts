/**
 * Steam Demos leaderboard — discovery.
 *
 * Primary source: store.steampowered.com/demos/ — Steam's own official
 * "Demos" storefront hub. This is an undocumented internal page (not a
 * keyed Web API endpoint), same risk tier as the appreviewhistogram
 * endpoint signals/console/steam.ts already depends on for console
 * leaderboards. Confirmed live 2026-09-22: the page embeds a real ranked
 * appid list for its "New and Trending" tab in a
 * `data-browser_contenthub_newandtrending_*` HTML attribute. Spot-checked
 * four returned appids against api/appdetails -- all type="demo",
 * is_free=true. Not a guess; this is real, live Steam data.
 *
 * Known limitations (leave here, don't silently work around them):
 *   - Only the "New and Trending" tab's list has been reverse-engineered so
 *     far. The hub also embeds "Recently Released" and "Daily Active User
 *     Demos" ("dailyactiveuserdemo") tabs, which would be a better universe
 *     for a pure "top demos by activity" ranking -- their backing ajax call
 *     has not been found yet. Follow-up work, not done here.
 *   - The hub page returned 50 appids on 2026-09-22; pagination past 50
 *     has not been confirmed to work (an attempted ?start=50 query
 *     returned a different, unrelated appid block, not page 2).
 *   - Every discovered appid is re-verified against api/appdetails before
 *     being trusted (type === "demo") -- never insert on hub-list
 *     membership alone.
 *
 * PORTABILITY: this file imports storage (SQLite) directly, matching the
 * console discovery.ts precedent -- it's fine for this to be
 * SignalPulse-specific, unlike the pure collectors in signals/console/.
 */

import { rawSqlite } from "../../storage";
import { log } from "../../log";

const DEMOS_HUB_URL = "https://store.steampowered.com/demos/";
const APPDETAILS_URL = (appId: string) => `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}`;
const USER_AGENT = "Mozilla/5.0 (compatible; SignalPulseBot/1.0)";

export type DiscoverySource = "steam_demos_hub" | "compset" | "saber_own" | "manual";

interface AppDetailsData {
  success: boolean;
  data?: {
    type?: string;
    name?: string;
    is_free?: boolean;
    genres?: Array<{ id: string; description: string }>;
  };
}

async function fetchText(url: string, timeoutMs = 15000): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} at ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the "New and Trending" tab's appid list from the Demos hub HTML.
 * The attribute name carries a numeric/tab suffix that could shift
 * (e.g. `data-browser_contenthub_newandtrending_0_50_13268_6_*_*_0`), so we
 * match on the stable `contenthub_newandtrending` prefix rather than the
 * full literal attribute name.
 */
export function parseDemosHubAppIds(html: string): string[] {
  const match = html.match(/data-browser_contenthub_newandtrending[a-zA-Z0-9_*]*="\{&quot;appids&quot;:\[([\d,]+)\]/);
  if (!match) return [];
  return Array.from(new Set(match[1].split(",").filter(Boolean)));
}

export async function fetchDemosHubAppIds(): Promise<string[]> {
  const html = await fetchText(DEMOS_HUB_URL);
  return parseDemosHubAppIds(html);
}

/**
 * Confirm an appid is genuinely a live demo before trusting any discovery
 * source. Returns null when api/appdetails no longer resolves the appid at
 * all (success:false) -- this is the same signal that flags a demo has
 * been deactivated post-launch (confirmed on Toxic Commando's demo,
 * appid 4354730).
 */
export async function verifyDemoAppId(appId: string): Promise<{ name: string; genre: string | null } | null> {
  const raw = await fetchText(APPDETAILS_URL(appId));
  const parsed = JSON.parse(raw) as Record<string, AppDetailsData>;
  const entry = parsed[appId];
  if (!entry?.success || !entry.data) return null;
  if (entry.data.type !== "demo") return null;
  const genre = entry.data.genres && entry.data.genres.length > 0
    ? entry.data.genres.map((g) => g.description).join(", ")
    : null;
  return { name: entry.data.name ?? `Steam demo ${appId}`, genre };
}

const upsertDemoTitleStmt = () => rawSqlite.prepare(
  `INSERT INTO demo_titles
     (steam_app_id, name, base_game_product_id, is_saber_published, genre,
      discovered_via, is_active, first_seen_at, last_checked_at, created_at, updated_at)
   VALUES (?, ?, NULL, 0, ?, ?, 1, ?, ?, ?, ?)
   ON CONFLICT(steam_app_id) DO UPDATE SET
     name = excluded.name,
     genre = COALESCE(excluded.genre, demo_titles.genre),
     is_active = 1,
     deactivated_at = NULL,
     last_checked_at = excluded.last_checked_at,
     updated_at = excluded.updated_at`
);

export function upsertDiscoveredDemo(params: {
  steamAppId: string;
  name: string;
  genre: string | null;
  discoveredVia: DiscoverySource;
}): void {
  const nowIso = new Date().toISOString();
  upsertDemoTitleStmt().run(
    params.steamAppId, params.name, params.genre, params.discoveredVia,
    nowIso, nowIso, nowIso, nowIso,
  );
}

export interface DemosHubDiscoveryResult {
  hubAppIdsFound: number;
  newlyDiscovered: number;
  alreadyKnown: number;
  rejectedNotDemo: number;
  failed: number;
  failureSample: Array<{ appId: string; reason: string }>;
}

/**
 * Run one discovery pass against the Steam Demos hub. Every hub appid is
 * re-verified via api/appdetails before being written -- hub-list
 * membership alone is never sufficient to trust an appid.
 */
export async function runDemosHubDiscovery(delayMs = 250): Promise<DemosHubDiscoveryResult> {
  const hubAppIds = await fetchDemosHubAppIds();
  const knownStmt = rawSqlite.prepare(`SELECT steam_app_id FROM demo_titles WHERE steam_app_id = ?`);

  const result: DemosHubDiscoveryResult = {
    hubAppIdsFound: hubAppIds.length,
    newlyDiscovered: 0,
    alreadyKnown: 0,
    rejectedNotDemo: 0,
    failed: 0,
    failureSample: [],
  };

  for (const appId of hubAppIds) {
    const already = knownStmt.get(appId);
    try {
      const verified = await verifyDemoAppId(appId);
      if (!verified) {
        result.rejectedNotDemo += 1;
        continue;
      }
      upsertDiscoveredDemo({
        steamAppId: appId,
        name: verified.name,
        genre: verified.genre,
        discoveredVia: "steam_demos_hub",
      });
      if (already) result.alreadyKnown += 1;
      else result.newlyDiscovered += 1;
    } catch (e) {
      result.failed += 1;
      if (result.failureSample.length < 5) {
        result.failureSample.push({ appId, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  log(
    `demos hub discovery: found=${result.hubAppIdsFound} new=${result.newlyDiscovered} known=${result.alreadyKnown} rejected=${result.rejectedNotDemo} failed=${result.failed}`,
    "demos-discovery",
  );
  return result;
}
