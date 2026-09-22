/**
 * Steam Demos leaderboard — discovery.
 *
 * Discovery now reads paginated Top Demos, New Releases and New &
 * Trending feeds. See feeds.ts for the verified dynamic endpoint.
 * Known limitations:
 *   - Top/Trending: 500 slots. New: 500 bootstrap, then catch-up to 2,000.
 *   - Every app and its parent are verified with batched Store Browse
 *     metadata (metadata.ts); hub-list membership alone is insufficient.
 *
 * PORTABILITY: this file imports storage (SQLite) directly, matching the
 * console discovery.ts precedent -- it's fine for this to be
 * SignalPulse-specific, unlike the pure collectors in signals/console/.
 */

import { rawSqlite } from "../../storage";
import { log } from "../../log";
import { DEMO_FEEDS, DEMOS_HUB_URL, fetchDemoFeed, fetchSteamText, parseDemoFeedContext, type DemoFeed, type DemoFeedPage } from "./feeds";
import { createDemoVerifier, type DemoVerifier, type VerifiedDemo } from "./metadata";
import type { SkuKind } from "./friends-pass-identity";

export type DiscoverySource = "steam_demos_hub" | "steam_friends_pass_search" | "compset" | "saber_own" | "manual";

const upsertDemoTitleStmt = () => rawSqlite.prepare(
  `INSERT INTO demo_titles
     (steam_app_id, name, base_game_product_id, is_saber_published, genre, release_date,
      discovered_via, is_active, first_seen_at, last_checked_at, created_at, updated_at,
      availability_source, availability_source_url, availability_checked_at, sku_kind)
   VALUES (?, ?, NULL, 0, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(steam_app_id) DO UPDATE SET
     name = excluded.name,
     sku_kind = excluded.sku_kind,
     genre = excluded.genre,
     release_date = excluded.release_date,
     is_active = 1,
     deactivated_at = NULL,
     availability_source = excluded.availability_source,
     availability_source_url = excluded.availability_source_url,
     availability_checked_at = excluded.availability_checked_at,
     last_checked_at = excluded.last_checked_at,
     updated_at = excluded.updated_at`
);

export function upsertDiscoveredDemo(params: {
  steamAppId: string;
  skuKind?: SkuKind;
  name: string;
  genre: string | null;
  releaseDate: string | null;
  availabilitySource?: VerifiedDemo["availabilitySource"];
  availabilitySourceUrl?: string | null;
  availabilityCheckedAt?: string;
  discoveredVia: DiscoverySource;
}): void {
  const nowIso = new Date().toISOString();
  upsertDemoTitleStmt().run(
    params.steamAppId, params.name, params.genre, params.releaseDate, params.discoveredVia,
    nowIso, nowIso, nowIso, nowIso,
    params.availabilitySource ?? null, params.availabilitySourceUrl ?? null, params.availabilityCheckedAt ?? null, params.skuKind ?? "demo",
  );
}

export interface DemosHubDiscoveryResult {
  hubAppIdsFound: number;
  newlyDiscovered: number;
  alreadyKnown: number;
  rejectedNotDemo: number;
  failed: number;
  failureSample: Array<{ appId: string; reason: string }>;
  feeds: Array<{ feed: DemoFeed; status: "success" | "error"; candidates: number; eligible: number; error?: string }>;
}

/**
 * Run one discovery pass against the Steam Demos hub. Every hub appid is
 * re-verified via Store Browse before being written -- hub-list
 * membership alone is never sufficient to trust an appid.
 */
export async function runDemosHubDiscovery(delayMs = 250, verifier: DemoVerifier = createDemoVerifier(delayMs)): Promise<DemosHubDiscoveryResult> {
  const pages = new Map<DemoFeed, DemoFeedPage>();
  const errors = new Map<DemoFeed, string>();
  const feeds = Object.keys(DEMO_FEEDS) as DemoFeed[];
  const attemptedAt = new Date().toISOString();
  try {
    const context = parseDemoFeedContext(await fetchSteamText(DEMOS_HUB_URL));
    for (const feed of feeds) {
      try {
        const prior = rawSqlite.prepare("SELECT anchor_app_ids FROM demo_discovery_feeds WHERE feed=?").get(feed) as { anchor_app_ids: string | null } | undefined;
        // Upgrade path uses the previous verified source head when raw anchors
        // have not yet been persisted. Never derive a watermark from title dates.
        const ids: string[] = prior?.anchor_app_ids ? JSON.parse(prior.anchor_app_ids) :
          (rawSqlite.prepare(`SELECT t.steam_app_id FROM demo_discovery_ranks r JOIN demo_titles t ON t.id=r.demo_title_id
            WHERE r.feed=? AND r.source_rank<=100 ORDER BY r.source_rank`).all(feed) as Array<{steam_app_id:string}>).map(r=>r.steam_app_id);
        pages.set(feed, await fetchDemoFeed(context, feed, async url=>{
          const body=await fetchSteamText(url);
          if(delayMs>0)await new Promise(resolve=>setTimeout(resolve,delayMs));
          return body;
        }, new Set(ids)));
      }
      catch (error) { errors.set(feed, error instanceof Error ? error.message : String(error)); }
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  } catch (error) {
    for (const feed of feeds) errors.set(feed, error instanceof Error ? error.message : String(error));
  }
  const hubAppIds = Array.from(new Set(Array.from(pages.values()).flatMap(page => page.entries.map(entry => entry.appId))));
  const verifiedIds = new Set<string>();
  const failedIds = new Set<string>();
  const verification = await verifier.verify(hubAppIds);
  const knownStmt = rawSqlite.prepare(`SELECT steam_app_id FROM demo_titles WHERE steam_app_id = ?`);

  const result: DemosHubDiscoveryResult = {
    hubAppIdsFound: hubAppIds.length,
    newlyDiscovered: 0,
    alreadyKnown: 0,
    rejectedNotDemo: 0,
    failed: 0,
    failureSample: [],
    feeds: [],
  };

  for (const appId of hubAppIds) {
    const already = knownStmt.get(appId);
    try {
      const check = verification.get(appId)!;
      if (check.error) throw new Error(check.error);
      const verified = check.demo;
      if (!verified) {
        result.rejectedNotDemo += 1;
        continue;
      }
      upsertDiscoveredDemo({
        steamAppId: appId,
        name: verified.name,
        genre: verified.genre,
        releaseDate: verified.releaseDate,
        availabilitySource: verified.availabilitySource,
        availabilitySourceUrl: verified.availabilitySourceUrl,
        availabilityCheckedAt: verified.availabilityCheckedAt,
        discoveredVia: "steam_demos_hub",
      });
      verifiedIds.add(appId);
      if (already) result.alreadyKnown += 1;
      else result.newlyDiscovered += 1;
    } catch (e) {
      failedIds.add(appId);
      result.failed += 1;
      if (result.failureSample.length < 5) {
        result.failureSample.push({ appId, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  for (const feed of feeds) {
    const page = pages.get(feed);
    if (page?.stopReason === "safety_cap") {
      errors.set(feed, `New Releases catch-up incomplete at ${page.scannedSlots} slots; prior watermark and ranking retained`);
    }
    if (page?.entries.some(entry => failedIds.has(entry.appId))) {
      errors.set(feed, "Demo metadata verification failed; retaining previous complete ranking");
    }
    const error = errors.get(feed);
    if (error || !page) {
      rawSqlite.prepare(`INSERT INTO demo_discovery_feeds(feed,last_attempt_at,error)
        VALUES (?,?,?) ON CONFLICT(feed) DO UPDATE SET
        last_attempt_at=excluded.last_attempt_at,error=excluded.error`).run(feed, attemptedAt, error ?? "Feed unavailable");
      result.feeds.push({ feed, status: "error", candidates: page?.entries.length ?? 0, eligible: 0, error });
      continue;
    }
    const eligible = page.entries.filter(entry => verifiedIds.has(entry.appId));
    rawSqlite.transaction(() => {
      rawSqlite.prepare("DELETE FROM demo_discovery_ranks WHERE feed=?").run(feed);
      const insert = rawSqlite.prepare(`INSERT INTO demo_discovery_ranks(feed,demo_title_id,source_rank)
        SELECT ?,id,? FROM demo_titles WHERE steam_app_id=?`);
      for (const entry of eligible) insert.run(feed, entry.rank, entry.appId);
      rawSqlite.prepare(`INSERT INTO demo_discovery_feeds
        (feed,last_attempt_at,last_success_at,error,candidate_count,eligible_count,total_matches,scanned_slots,stop_reason,anchor_app_ids)
        VALUES (?,?,?,NULL,?,?,?,?,?,?) ON CONFLICT(feed) DO UPDATE SET
        last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,error=NULL,
        candidate_count=excluded.candidate_count,eligible_count=excluded.eligible_count,total_matches=excluded.total_matches,
        scanned_slots=excluded.scanned_slots,stop_reason=excluded.stop_reason,anchor_app_ids=excluded.anchor_app_ids`)
        .run(feed, attemptedAt, new Date().toISOString(), page.entries.length, eligible.length, page.totalMatches,
          page.scannedSlots,page.stopReason,JSON.stringify(page.entries.slice(0,100).map(e=>e.appId)));
    })();
    result.feeds.push({ feed, status: "success", candidates: page.entries.length, eligible: eligible.length });
  }
  log(`demos feeds: ${JSON.stringify(result.feeds)}`, "demos-discovery");
  log(
    `demos hub discovery: found=${result.hubAppIdsFound} new=${result.newlyDiscovered} known=${result.alreadyKnown} rejected=${result.rejectedNotDemo} failed=${result.failed}`,
    "demos-discovery",
  );
  return result;
}
