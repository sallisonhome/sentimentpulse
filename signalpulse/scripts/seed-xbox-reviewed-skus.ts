/**
 * Writes the reviewed Xbox SKUs in server/xbox-reviewed-skus.ts into platform_sku_map.
 * DRY_RUN=1 prints the plan and writes nothing. Idempotent: existing rows are left alone.
 * Also lands each bigId in xbox_title_cache (required for the Xbox boards to show the row).
 * The base SKU gets a new title_id (max + 1, inside an immediate transaction); editions share it.
 */
import { rawSqlite } from "../server/storage";
import { classifyXboxBigIds, upsertSkuMap, bootstrapConsoleTitleNames } from "../server/signals/console/discovery";
import { landXboxBigIds } from "../server/signals/console/xbox-title-resolver";
import { REVIEWED_XBOX_FAMILIES, XBOX_REVIEWED_SOURCE, planReviewedFamily } from "../server/xbox-reviewed-skus";

const DRY = process.env.DRY_RUN === "1";
async function main() {
  let failed = 0;
  for (const fam of REVIEWED_XBOX_FAMILIES) {
    const cls = await classifyXboxBigIds(fam.skus.map(s => s.bigId));
    const names: Record<string, string | null> = Object.fromEntries(cls.map(c => [c.bigId, c.name]));
    const existingRows = rawSqlite.prepare(
      `SELECT external_sku, title_id FROM platform_sku_map WHERE platform='xbox' AND external_sku IN (${fam.skus.map(() => "?").join(",")})`,
    ).all(...fam.skus.map(s => s.bigId)) as Array<{ external_sku: string; title_id: number }>;
    const plan = planReviewedFamily(fam, names, new Set(existingRows.map(r => r.external_sku)));
    console.log(`[${fam.family}]`, JSON.stringify(plan), "store names:", JSON.stringify(names));
    if (plan.some(p => p.action === "reject")) { failed++; console.error("rejected, nothing written for this family"); continue; }
    if (DRY) continue;
    // The Xbox boards read name and art from xbox_title_cache and drop any Xbox row without one.
    // Rows that discovery never saw are not in that cache, so land them here (idempotent).
    const landed = await landXboxBigIds(fam.skus.map(s => s.bigId));
    console.log("xbox_title_cache land:", JSON.stringify(landed));
    const base = fam.skus.find(s => s.role === "base")!;
    const titleId = rawSqlite.transaction((): number => {
      const have = existingRows.find(r => r.external_sku === base.bigId) ?? existingRows[0];
      if (have) return have.title_id;
      const { m } = rawSqlite.prepare("SELECT COALESCE(MAX(title_id), 9999) AS m FROM platform_sku_map").get() as { m: number };
      return m + 1;
    }).immediate();
    const rows = fam.skus.filter(s => plan.find(p => p.bigId === s.bigId)!.action === "insert").map(s => ({
      platform: "xbox" as const, externalSku: s.bigId, titleId, conceptId: null, skuRole: s.role,
      businessModel: "paid" as const, msrpUsdCents: s.msrpUsdCents, businessModelSource: XBOX_REVIEWED_SOURCE,
      isManualOverride: true,
    }));
    const w = upsertSkuMap(rows);
    const b = cls.find(c => c.bigId === base.bigId)!;
    bootstrapConsoleTitleNames([{ titleId, name: fam.family, headerImageUrl: b.headerImageUrl, releaseDateIso: b.releaseDateIso }]);
    console.log(`wrote title_id=${titleId}`, JSON.stringify(w));
  }
  if (failed) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(2); });
