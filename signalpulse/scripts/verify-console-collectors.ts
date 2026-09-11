/**
 * Phase 2 verification — live end-to-end run of all three console collectors.
 *
 * PRINCIPLES.md §1: verify, do not infer. This script seeds a small set of
 * real premium-paid titles into platform_sku_map, runs each collector, and
 * inspects the DB afterward to confirm:
 *   - snapshots landed in store_rating_signal_daily with rating_count > 0
 *   - Steam buckets landed in steam_review_history
 *   - a deliberately-seeded F2P row was gated out (not ingested)
 *   - a title absent from platform_sku_map was gated out (unknown)
 *
 * Not a unit test — this hits Valve, Microsoft, and Sony's production servers.
 * Run manually or on-demand.
 */

import { rawSqlite } from "../server/storage";
import { runConsoleLeaderboardIngest } from "../server/signals/console/runner";

interface SeedRow {
  title_id: number;
  platform: "steam" | "ps5" | "xbox";
  external_sku: string;
  sku_role: string;
  business_model: "paid" | "free_to_play";
  msrp_usd_cents: number | null;
  business_model_source: string;
}

const nowIso = new Date().toISOString();

// Real premium-paid titles + one deliberate F2P to prove the gate fires.
const SEED: SeedRow[] = [
  // Steam — paid
  { title_id: 9001, platform: "steam", external_sku: "1245620",  sku_role: "base", business_model: "paid", msrp_usd_cents: 5999, business_model_source: "manual_seed_elden_ring" },
  { title_id: 9002, platform: "steam", external_sku: "2050650",  sku_role: "base", business_model: "paid", msrp_usd_cents: 6999, business_model_source: "manual_seed_re4_remake" },
  { title_id: 9003, platform: "steam", external_sku: "553850",   sku_role: "base", business_model: "paid", msrp_usd_cents: 3999, business_model_source: "manual_seed_helldivers2" },
  // Steam — F2P (should be gated OUT)
  { title_id: 9099, platform: "steam", external_sku: "578080",   sku_role: "base", business_model: "free_to_play", msrp_usd_cents: 0, business_model_source: "manual_seed_pubg" },
  // Xbox — paid
  { title_id: 9101, platform: "xbox",  external_sku: "9NKX70BBCDRN", sku_role: "base", business_model: "paid", msrp_usd_cents: 5999, business_model_source: "manual_seed_forza_horizon_5" },
  // PS — paid
  { title_id: 9201, platform: "ps5",   external_sku: "UP9000-PPSA01413_00-HELLDIVERS200000", sku_role: "base", business_model: "paid", msrp_usd_cents: 3999, business_model_source: "manual_seed_helldivers2" },
];

// Also a Steam appid that we DELIBERATELY do NOT seed — proves the "unknown" gate fires.
const UNSEEDED_STEAM_APPID = "1174180";

function seedPlatformSkuMap() {
  const stmt = rawSqlite.prepare(
    `INSERT INTO platform_sku_map
       (title_id, platform, external_sku, concept_id, sku_role,
        business_model, msrp_usd_cents, business_model_source, is_manual_override,
        refreshed_at, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(platform, external_sku) DO UPDATE SET
       business_model = excluded.business_model,
       msrp_usd_cents = excluded.msrp_usd_cents,
       business_model_source = excluded.business_model_source,
       refreshed_at = excluded.refreshed_at`
  );
  for (const r of SEED) {
    stmt.run(r.title_id, r.platform, r.external_sku, r.sku_role, r.business_model, r.msrp_usd_cents, r.business_model_source, nowIso, nowIso);
  }
}

// PSN productIds that we KNOW are synthetic/invalid — Sony returns
// "Product not available" (errorCode 3166081) for these. They were injected
// by an earlier seed run before we discovered the real productIds. Delete
// them so the collector iteration doesn't waste vendor calls or generate
// noisy failed-run signal.
const STALE_PS_SKUS = [
  "UP4133-PPSA07784_00-SPACEMARINE20000",
  "UP1003-PPSA02439_00-STARWARSJEDISUR2",
  "UP0002-PPSA05127_00-ELDENRINGGAME000",
];

function cleanupStalePsSkus(): number {
  const stmt = rawSqlite.prepare(
    `DELETE FROM platform_sku_map WHERE platform = 'ps5' AND external_sku = ?`
  );
  let n = 0;
  for (const sku of STALE_PS_SKUS) {
    const res = stmt.run(sku);
    n += res.changes;
  }
  return n;
}

async function main() {
  console.log("─── cleanup stale/synthetic PS productIds ───");
  const cleaned = cleanupStalePsSkus();
  console.log(`  removed ${cleaned} stale ps5 rows`);

  console.log("─── seeding platform_sku_map ───");
  seedPlatformSkuMap();
  const seeded = rawSqlite.prepare(`SELECT platform, external_sku, business_model FROM platform_sku_map ORDER BY platform, external_sku`).all();
  console.log(seeded);

  // Build the full collector input set. For each platform, fetch every SKU
  // in platform_sku_map (regardless of business_model — the collector's own
  // gate filters F2P/unknown before hitting vendor APIs). Then append two
  // Steam probes that MUST NOT ingest, to keep gate-behaviour under test:
  //   - appid 578080 (PUBG) — seeded above as free_to_play → should be gated F2P
  //   - appid UNSEEDED_STEAM_APPID — not in the map at all → should be gated unknown
  console.log("\n─── building collector inputs from platform_sku_map ───");
  const steamSkus = rawSqlite.prepare(
    `SELECT external_sku FROM platform_sku_map WHERE platform = 'steam'`
  ).all() as Array<{ external_sku: string }>;
  const xboxSkus = rawSqlite.prepare(
    `SELECT external_sku FROM platform_sku_map WHERE platform = 'xbox'`
  ).all() as Array<{ external_sku: string }>;
  const psSkus = rawSqlite.prepare(
    `SELECT external_sku FROM platform_sku_map WHERE platform = 'ps5'`
  ).all() as Array<{ external_sku: string }>;

  const steamInputs = steamSkus.map(r => ({ titleId: 0, appId: r.external_sku }));
  // Append gate probes if they aren't already present.
  if (!steamInputs.some(r => r.appId === UNSEEDED_STEAM_APPID)) {
    steamInputs.push({ titleId: 0, appId: UNSEEDED_STEAM_APPID });
  }
  const xboxInputs = xboxSkus.map(r => ({ titleId: 0, bigId: r.external_sku }));
  const psInputs = psSkus.map(r => ({ titleId: 0, productId: r.external_sku }));

  console.log(`  steam inputs: ${steamInputs.length}  xbox inputs: ${xboxInputs.length}  ps inputs: ${psInputs.length}`);

  console.log("\n─── running collectors ───");
  const result = await runConsoleLeaderboardIngest({
    steam: steamInputs,
    xbox: xboxInputs,
    ps: psInputs,
  });

  console.log("\n─── per-platform run summary ───");
  console.log(JSON.stringify(result, null, 2));

  console.log("\n─── DB inspection ───");
  const snapshots = rawSqlite.prepare(
    `SELECT title_id, platform, capture_date, rating_count, avg_rating, window_label, is_native_window, sku_count
       FROM store_rating_signal_daily
      ORDER BY platform, title_id`
  ).all();
  console.log("store_rating_signal_daily:", snapshots);

  const bucketCount = rawSqlite.prepare(
    `SELECT app_id, bucket_granularity, COUNT(*) AS n
       FROM steam_review_history
      GROUP BY app_id, bucket_granularity
      ORDER BY app_id, bucket_granularity`
  ).all();
  console.log("steam_review_history bucket counts:", bucketCount);

  // Assertions — surface any silent failure loudly.
  //
  // Note: title_id is allocated by whichever code path first inserted the row
  // into platform_sku_map — this script's seed uses ON CONFLICT that preserves
  // the existing title_id, and discovery uses its own allocator. So we cannot
  // assert on specific title_id values. Look up by (platform, external_sku) to
  // resolve the actual title_id, then verify each expected snapshot exists.
  const errors: string[] = [];
  const resolveTitleId = (platform: string, externalSku: string): number | null => {
    const row = rawSqlite.prepare(
      `SELECT title_id FROM platform_sku_map WHERE platform = ? AND external_sku = ?`
    ).get(platform, externalSku) as { title_id: number } | undefined;
    return row?.title_id ?? null;
  };

  // Paid Steam snapshots — expect at least one across the three seeded appids.
  const steamPaidIds = ["1245620", "2050650", "553850"]
    .map(sku => resolveTitleId("steam", sku))
    .filter((id): id is number => id != null);
  const paidSteamCount = (snapshots as Array<{platform:string;title_id:number}>)
    .filter(r => r.platform === "steam" && steamPaidIds.includes(r.title_id)).length;
  if (paidSteamCount < 1) errors.push(`expected >=1 Steam paid snapshot, got ${paidSteamCount} (resolved title_ids=${steamPaidIds.join(",")})`);

  // F2P gate — PUBG (appid 578080) should NOT produce a snapshot regardless of title_id.
  const pubgId = resolveTitleId("steam", "578080");
  if (pubgId != null) {
    const f2pRow = (snapshots as Array<{title_id:number}>).find(r => r.title_id === pubgId);
    if (f2pRow) errors.push(`F2P PUBG (title_id=${pubgId}, appid=578080) was NOT gated — bug in ingest gate`);
  }

  // Xbox Forza — resolve by bigId, then assert snapshot exists with real ratings.
  const forzaId = resolveTitleId("xbox", "9NKX70BBCDRN");
  const xboxRow = forzaId != null
    ? (snapshots as Array<{platform:string;title_id:number;rating_count:number|null}>).find(r => r.platform === "xbox" && r.title_id === forzaId)
    : undefined;
  if (!xboxRow) errors.push(`expected Xbox Forza row (resolved title_id=${forzaId}), got none`);
  else if (xboxRow.rating_count == null || xboxRow.rating_count <= 0) errors.push(`Xbox Forza rating_count is ${xboxRow.rating_count}`);

  // PS Helldivers 2 — resolve by productId.
  const hd2Id = resolveTitleId("ps5", "UP9000-PPSA01413_00-HELLDIVERS200000");
  const psRow = hd2Id != null
    ? (snapshots as Array<{platform:string;title_id:number;rating_count:number|null}>).find(r => r.platform === "ps5" && r.title_id === hd2Id)
    : undefined;
  if (!psRow) errors.push(`expected PS Helldivers 2 row (resolved title_id=${hd2Id}), got none`);
  else if (psRow.rating_count == null || psRow.rating_count <= 0) errors.push(`PS Helldivers 2 rating_count is ${psRow.rating_count}`);

  if (errors.length > 0) {
    console.error("\n❌ VERIFICATION FAILED:");
    for (const e of errors) console.error("  •", e);
    process.exit(1);
  }
  console.log("\n✅ Phase 2 verification passed.");
  process.exit(0);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(2);
});
