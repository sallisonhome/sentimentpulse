// Pure (no database, no network) parts of the deep daily chart. See deepChart.ts for the wiring and the rules.
import { xboxPricingFromProduct } from "./xbox";

export type DeepBusinessModel = "paid" | "free_to_play" | "unknown";
export interface DeepItem { rawPosition: number; externalSku: string; name: string | null; businessModel: DeepBusinessModel; msrpUsdCents: number | null }
export interface RankedDeepItem extends DeepItem { paidRank: number | null }

export interface XboxDeepDeps {
  fetchPage: (channelId: string, ct: string | null) => Promise<{ productIds: string[]; nextCT: string | null }>;
  fetchProducts: (bigIds: string[]) => Promise<any[]>;
  sleep: (ms: number) => Promise<void>;
}

/** Ordered, de-duplicated bigIds from the top-paid channel, up to maxItems. */
export async function collectXboxChartIds(maxItems: number, deps: XboxDeepDeps): Promise<string[]> {
  const ids: string[] = []; const seen = new Set<string>();
  let ct: string | null = null;
  for (let page = 0; page < Math.ceil(maxItems / 25) + 2 && ids.length < maxItems; page++) {
    const { productIds, nextCT } = await deps.fetchPage("top-paid-games", ct);
    for (const id of productIds) if (!seen.has(id) && ids.length < maxItems) { seen.add(id); ids.push(id); }
    if (!nextCT) break;
    ct = nextCT;
    await deps.sleep(250);
  }
  return ids;
}

/** Batched displaycatalog classification (20 per request) using the production pricing rule. */
export async function classifyXboxChart(ids: string[], deps: XboxDeepDeps): Promise<DeepItem[]> {
  const byId = new Map<string, { name: string | null; businessModel: DeepBusinessModel; msrp: number | null }>();
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    try {
      for (const p of await deps.fetchProducts(batch)) {
        const pr = xboxPricingFromProduct(p);
        byId.set(p.ProductId, {
          name: p.LocalizedProperties?.[0]?.ProductTitle ?? null,
          businessModel: pr.allSkusZero ? "free_to_play" : pr.baseMsrpUsdCents == null ? "unknown" : "paid",
          msrp: pr.baseMsrpUsdCents,
        });
      }
    } catch { /* batch failed: its SKUs stay unknown and keep their rank */ }
    await deps.sleep(150);
  }
  return ids.map((id, i) => {
    const c = byId.get(id);
    return { rawPosition: i + 1, externalSku: id, name: c?.name ?? null, businessModel: c?.businessModel ?? "unknown", msrpUsdCents: c?.msrp ?? null };
  });
}


/** Dense paid-only rerank in store order. Free-to-play gets NULL. Pure. */
export function rerankPaidOnly(items: DeepItem[]): RankedDeepItem[] {
  const sorted = [...items].sort((a, b) => a.rawPosition - b.rawPosition);
  let r = 0;
  return sorted.map(it => ({ ...it, paidRank: it.businessModel === "free_to_play" ? null : ++r }));
}

