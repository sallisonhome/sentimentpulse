/**
 * Production collection: no seed writes, fake gate probes, or catalog deletes.
 * Success is measured from THIS invocation, not historical DB rows.
 */
import { rawSqlite } from "../server/storage";
import { runConsoleLeaderboardIngest } from "../server/signals/console/runner";
import { collectionHealth } from "../server/daily-refresh-health";

async function main() {
  const skus = (platform: string) => (rawSqlite.prepare(
    "SELECT external_sku FROM platform_sku_map WHERE platform=? ORDER BY external_sku"
  ).all(platform) as Array<{ external_sku: string }>).map(r => r.external_sku);
  const result = await runConsoleLeaderboardIngest({
    steam: skus("steam").map(appId => ({ titleId: 0, appId })),
    xbox: skus("xbox").map(bigId => ({ titleId: 0, bigId })),
    ps: skus("ps5").map(productId => ({ titleId: 0, productId })),
  });
  console.log(JSON.stringify(result, null, 2));
  const health = collectionHealth(result.perPlatform);
  for (const warning of health.warnings) console.warn(`COLLECTION WARNING: ${warning}`);
  if (health.errors.length) throw new Error(health.errors.join("; "));
  console.log("PRODUCTION COLLECTION PASSED: fresh per-platform observations verified");
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
