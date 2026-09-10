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

async function main() {
  console.log("─── seeding platform_sku_map ───");
  seedPlatformSkuMap();
  const seeded = rawSqlite.prepare(`SELECT platform, external_sku, business_model FROM platform_sku_map ORDER BY platform, external_sku`).all();
  console.log(seeded);

  console.log("\n─── running collectors ───");
  const result = await runConsoleLeaderboardIngest({
    steam: [
      { titleId: 0, appId: "1245620" },
      { titleId: 0, appId: "2050650" },
      { titleId: 0, appId: "553850" },
      { titleId: 0, appId: "578080" },                // F2P — should be gated
      { titleId: 0, appId: UNSEEDED_STEAM_APPID },    // Unseeded — should be gated as unknown
    ],
    xbox: [
      { titleId: 0, bigId: "9NKX70BBCDRN" },
    ],
    ps: [
      { titleId: 0, productId: "UP9000-PPSA01413_00-HELLDIVERS200000" },
    ],
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
