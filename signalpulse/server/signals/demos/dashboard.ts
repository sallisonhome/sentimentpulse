import type { DashboardDemoDownloads } from "../../../shared/demo-dashboard";
import { rawSqlite } from "../../storage";
import { SABER_DEMO_ROSTER } from "./saber-seed";

interface ProductIdentity { id: number; steamAppId: string | null }

/** A dedicated actuals read; never imports leaderboard estimates or license
 * categories. Explicit approved demo/parent identities also include Saber-
 * developed, externally published games (Toxic Commando), without changing
 * the paid game's publisher flag. Retired demos retain lifetime totals.
 */
export function loadDashboardDemoDownloads(products: ProductIdentity[]): Map<number, DashboardDemoDownloads[]> {
  const byProduct = new Map<number, DashboardDemoDownloads[]>();
  for (const demo of SABER_DEMO_ROSTER) {
    if (!demo.parentSteamAppId) continue;
    const matches = products.filter(product => product.steamAppId === demo.parentSteamAppId);
    if (matches.length !== 1) continue;
    const row = rawSqlite.prepare("SELECT * FROM demo_download_actuals WHERE steam_app_id=? AND window='ltd'").get(demo.steamAppId) as any;
    const title = rawSqlite.prepare("SELECT is_active,base_game_product_id FROM demo_titles WHERE steam_app_id=?").get(demo.steamAppId) as any;
    if (title?.base_game_product_id != null && title.base_game_product_id !== matches[0].id) continue;
    const actual = row?.source === "steamworks_downloads_report" && Number.isSafeInteger(row.downloads) && row.downloads >= 0;
    const item: DashboardDemoDownloads = {
      demoAppId: demo.steamAppId, demoName: demo.name,
      lifetimeDownloads: actual ? row.downloads : null,
      valueKind: actual ? "steamworks_actual" : "unavailable",
      asOfDate: actual ? row.report_end_date : null,
      fetchedAt: actual ? row.fetched_at : null,
      sourceUrl: actual ? row.source_url : null,
      refreshFailed: !!row?.last_error,
      isArchived: title ? title.is_active !== 1 : !demo.isActive,
      isStale: !actual || !Number.isFinite(Date.parse(row.fetched_at)) || Date.now() - Date.parse(row.fetched_at) > 3 * 86_400_000,
    };
    const rows = byProduct.get(matches[0].id) ?? [];
    rows.push(item);
    byProduct.set(matches[0].id, rows);
  }
  return byProduct;
}
