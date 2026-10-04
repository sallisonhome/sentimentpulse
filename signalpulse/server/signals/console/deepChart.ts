// Deep daily storefront chart: the full returned chart (Xbox top-paid about 1,000 deep, PS5 sales30 grid about 500),
// free-to-play dropped and the survivors re-ranked paid-only, stored with the raw position so the rerank can be audited.
//
// Why: discovery keeps only the top 100 per platform, so every title below that was "off chart" and capped at one flat
// value. The deep rank lets the chart-consistency pass give a rank-based ceiling instead.
//
// Rules (same as the leaderboard):
//   - free_to_play rows are dropped from the ranking (paid_rank NULL) but kept in the table for audit/replay.
//   - `unknown` classifications stay ranked (the leaderboard keeps them so they can self-heal).
//   - paid_rank is dense 1..N in store order. No title_id is minted for unknown SKUs; the title is joined from
//     platform_sku_map by external_sku at read time.
//   - An empty or tiny fetch never wipes a stored day.

import { writeDeepChart } from "./deepChartStore";
import { fetchJson } from "./types";
import { fetchXboxEmeraldPage, discoverPs5TopSelling, classifyPs5TopSelling } from "./discovery";

export * from "./deepChartCore";
export { writeDeepChart, readDeepRankByTitle, DEEP_SORT_KEY, DEEP_MIN_ROWS_TO_STORE } from "./deepChartStore";
import type { DeepItem, RankedDeepItem, DeepBusinessModel, XboxDeepDeps } from "./deepChartCore";
import { rerankPaidOnly, collectXboxChartIds as collectIds, classifyXboxChart as classify } from "./deepChartCore";


export const realXboxDeps: XboxDeepDeps = {
  fetchPage: (c, ct) => fetchXboxEmeraldPage(c, ct),
  fetchProducts: async (bigIds) => {
    const url = `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${bigIds.map(encodeURIComponent).join(",")}&market=US&languages=en-us`;
    const raw: any = await fetchJson<any>(url, { timeoutMs: 20000 });
    return Array.isArray(raw?.Products) ? raw.Products : [];
  },
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
};

/** PS5: one row per npTitleId group in sales30 order; classification is the production rule (base MSRP 0 = free). */
export async function collectPs5Chart(maxGroups: number): Promise<DeepItem[]> {
  const top = await discoverPs5TopSelling(maxGroups);
  const cls = await classifyPs5TopSelling(top);
  return cls.map((c, i) => ({ rawPosition: i + 1, externalSku: c.productId, name: c.name, businessModel: c.businessModel as DeepBusinessModel, msrpUsdCents: c.msrpUsdCents }));
}

export interface DeepRunOptions { xboxMax?: number; ps5Max?: number; log?: (m: string) => void }

/** Pull, classify, rerank and store both platforms. Never throws: a failure on one platform leaves its stored days alone. */
export async function runDeepChartSnapshot(opts: DeepRunOptions = {}): Promise<void> {
  const log = opts.log ?? (() => {});
  if (process.env.DEEP_CHART_DISABLE === "1") { log("deep chart: disabled by DEEP_CHART_DISABLE=1"); return; }
  const t0 = Date.now();
  try {
    const ids = await collectIds(opts.xboxMax ?? 1000, realXboxDeps);
    const ranked = rerankPaidOnly(await classify(ids, realXboxDeps));
    const w = writeDeepChart("xbox", ranked);
    const f2p = ranked.filter(r => r.businessModel === "free_to_play").length, unk = ranked.filter(r => r.businessModel === "unknown").length;
    log(`deep chart xbox: fetched=${ids.length} f2pDropped=${f2p} unknown=${unk} paidRanked=${ranked.length - f2p} stored=${w.rowsWritten}${w.skipped ? " skipped=" + w.skipped : ""}`);
  } catch (e: any) { log(`deep chart xbox failed (non-fatal): ${e?.message ?? e}`); }
  try {
    const items = await collectPs5Chart(opts.ps5Max ?? 500);
    const ranked = rerankPaidOnly(items);
    const w = writeDeepChart("ps5", ranked);
    const f2p = ranked.filter(r => r.businessModel === "free_to_play").length;
    log(`deep chart ps5: groups=${items.length} f2pDropped=${f2p} paidRanked=${ranked.length - f2p} stored=${w.rowsWritten}${w.skipped ? " skipped=" + w.skipped : ""}`);
  } catch (e: any) { log(`deep chart ps5 failed (non-fatal): ${e?.message ?? e}`); }
  log(`deep chart: done in ${Math.round((Date.now() - t0) / 1000)}s`);
}
