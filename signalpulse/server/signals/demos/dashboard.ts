import type { DashboardDemoDownloads } from "../../../shared/demo-dashboard";
import { rawSqlite } from "../../storage";

interface ProductIdentity { id: number; steamAppId: string | null }

/** A dedicated actuals read; never imports leaderboard estimates or license
 * categories. Explicit approved demo/parent identities also include Saber-
 * developed, externally published games (Toxic Commando), without changing
 * the paid game's publisher flag. Retired demos retain lifetime totals.
 * Downloads here are Steamworks playtime/preload downloads; free licenses
 * (a separate Steamworks metric) are joined from demo_portal_daily.
 */
export function loadDashboardDemoDownloads(products: ProductIdentity[]): Map<number, DashboardDemoDownloads[]> {
  const byProduct = new Map<number, DashboardDemoDownloads[]>();
  // DB-driven (2026-10-22): iterate every Saber-published demo with a
  // resolved parent product link (base_game_product_id, set by the roster
  // seed or hub discovery). The roster is no longer the iteration source.
  const demos = rawSqlite.prepare(`SELECT t.id, t.steam_app_id, t.name, t.is_active, t.base_game_product_id,
      a.downloads, a.report_end_date, a.fetched_at, a.source_url, a.last_error, a.source
    FROM demo_titles t
    LEFT JOIN demo_download_actuals a ON a.steam_app_id = t.steam_app_id AND a.window = 'ltd'
    WHERE t.is_saber_published = 1 AND t.base_game_product_id IS NOT NULL`).all() as any[];
  for (const demo of demos) {
    const matches = products.filter(product => product.id === demo.base_game_product_id);
    if (matches.length !== 1) continue;
    const row = demo;
    const title = { id: demo.id, is_active: demo.is_active, base_game_product_id: demo.base_game_product_id };
    // Latest licenses snapshot for this demo (never summed; the portal's
    // lifetime box is cumulative-to-date at fetch time). Selected by the
    // RETRIEVAL timestamp (updated_at) -- the observation time -- not the
    // collector's target date, so a late refresh supersedes an earlier
    // same-day snapshot. The row's date field is the collector's target
    // date, not the lifetime observation date.
    const licenses = title?.id != null
      ? rawSqlite.prepare(
          `SELECT lifetime_free_licenses, updated_at FROM demo_portal_daily
           WHERE demo_title_id=? AND lifetime_free_licenses IS NOT NULL
           ORDER BY updated_at DESC LIMIT 1`
        ).get(title.id) as { lifetime_free_licenses: number; updated_at: string } | undefined
      : undefined;
    if (title?.base_game_product_id != null && title.base_game_product_id !== matches[0].id) continue;
    const actual = row?.source === "steamworks_downloads_report" && Number.isSafeInteger(row.downloads) && row.downloads >= 0;
    const licensesValid = licenses != null && Number.isSafeInteger(licenses.lifetime_free_licenses) && licenses.lifetime_free_licenses >= 0;
    const item: DashboardDemoDownloads = {
      demoAppId: demo.steam_app_id, demoName: demo.name,
      lifetimeDownloads: actual ? row.downloads : null,
      valueKind: actual ? "steamworks_actual" : "unavailable",
      asOfDate: actual ? row.report_end_date : null,
      fetchedAt: actual ? row.fetched_at : null,
      sourceUrl: actual ? row.source_url : null,
      refreshFailed: !!row?.last_error,
      isArchived: title.is_active !== 1,
      isStale: !actual || !Number.isFinite(Date.parse(row.fetched_at)) || Date.now() - Date.parse(row.fetched_at) > 3 * 86_400_000,
      lifetimeFreeLicenses: licensesValid ? licenses!.lifetime_free_licenses : null,
      licensesAsOf: licensesValid ? licenses!.updated_at : null,
      licensesStale: !licensesValid || !Number.isFinite(Date.parse(licenses!.updated_at)) || Date.now() - Date.parse(licenses!.updated_at) > 3 * 86_400_000,
    };
    const rows = byProduct.get(matches[0].id) ?? [];
    rows.push(item);
    byProduct.set(matches[0].id, rows);
  }
  return byProduct;
}
