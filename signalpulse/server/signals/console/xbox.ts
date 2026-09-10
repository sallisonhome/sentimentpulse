/**
 * Xbox collector — Microsoft Store displaycatalog UsageData.
 *
 * Endpoint: https://displaycatalog.mp.microsoft.com/v7.0/products/{bigId}?market=US&languages=en-us
 * Public, no key. Returns a single `Product` object at the top level (NOT the
 * `Products[]` array the spec claimed). Phase 0 (2026-09-10) confirmed the
 * singular shape on both Forza Horizon 5 and Minecraft.
 *
 * Rating window fields live in `Product.MarketProperties[].UsageData[]` where
 * each entry has an AggregateTimeSpan of "7Days" | "30Days" | "AllTime" and a
 * RatingCount / AverageRating. PlayCount / PurchaseCount / TrialCount are
 * always zero for public catalog reads — do NOT use them.
 *
 * We also parse pricing here so business-model classification (Phase 3
 * discovery) reads from the same response: if every SKU's MSRP is 0, F2P;
 * otherwise use the base-SKU MSRP.
 */

import { CollectorFailure, CollectorResult, StoreRatingSnapshot, fetchJson, todayUtc } from "./types";

// Shape is defensive — displaycatalog occasionally omits fields; treat all as optional.
interface DisplayCatalogUsageData {
  AggregateTimeSpan?: "7Days" | "30Days" | "AllTime" | string;
  RatingCount?: number;
  AverageRating?: number;
  PlayCount?: number;                        // always 0 for public reads (ignore)
  PurchaseCount?: number;                    // always 0 for public reads (ignore)
  TrialCount?: number;                       // always 0 for public reads (ignore)
}

interface DisplayCatalogPrice {
  ListPrice?: number;
  MSRP?: number;
  CurrencyCode?: string;
}

interface DisplayCatalogAvailability {
  OrderManagementData?: { Price?: DisplayCatalogPrice };
}

interface DisplayCatalogSku {
  SkuId?: string;
  SkuType?: string;                          // "Full" | "Trial" | ...
}

interface DisplayCatalogDisplaySkuAvailability {
  Sku?: DisplayCatalogSku;
  Availabilities?: DisplayCatalogAvailability[];
  HistoricalBestAvailabilities?: DisplayCatalogAvailability[];
}

interface DisplayCatalogMarketProperties {
  UsageData?: DisplayCatalogUsageData[];
  UsageDataAggregates?: DisplayCatalogUsageData[];  // alt field name seen in the wild
}

interface DisplayCatalogProduct {
  ProductId?: string;
  ProductTitle?: string;
  MarketProperties?: DisplayCatalogMarketProperties[];
  DisplaySkuAvailabilities?: DisplayCatalogDisplaySkuAvailability[];
  LocalizedProperties?: Array<{ ProductTitle?: string }>;
}

// Response has either { Product: {...} } (observed) or { Products: [ {...} ] } (spec).
// We accept both to survive Microsoft flipping the shape.
interface DisplayCatalogResponse {
  Product?: DisplayCatalogProduct;
  Products?: DisplayCatalogProduct[];
}

const ENDPOINT = "xbox:displaycatalog";

export interface XboxCollectorInput {
  titleId: number;
  bigId: string;
}

export interface XboxCollectorOutput {
  snapshots: StoreRatingSnapshot[];          // one per window: d7, d30, ltd (native)
  pricing: {
    allSkusZero: boolean;                    // true → free_to_play classification
    baseMsrpUsdCents: number | null;
    currency: string | null;
  };
  productTitle: string | null;
}

function unwrapProduct(raw: DisplayCatalogResponse): DisplayCatalogProduct | null {
  if (raw?.Product && typeof raw.Product === "object") return raw.Product;
  if (Array.isArray(raw?.Products) && raw.Products.length > 0) return raw.Products[0];
  return null;
}

function windowFromTimeSpan(span: string | undefined): "d7" | "d30" | "ltd" | null {
  if (span === "7Days") return "d7";
  if (span === "30Days") return "d30";
  if (span === "AllTime") return "ltd";
  return null;
}

export async function fetchXboxRatingSignal(input: XboxCollectorInput): Promise<XboxCollectorOutput> {
  const url = `https://displaycatalog.mp.microsoft.com/v7.0/products/${encodeURIComponent(input.bigId)}?market=US&languages=en-us`;
  const raw = await fetchJson<DisplayCatalogResponse>(url, { timeoutMs: 15000 });

  const product = unwrapProduct(raw);
  if (!product) throw new Error(`xbox displaycatalog returned no product for bigId=${input.bigId}`);

  const productTitle =
    product.LocalizedProperties?.[0]?.ProductTitle ??
    product.ProductTitle ??
    null;

  const usage: DisplayCatalogUsageData[] =
    (product.MarketProperties?.[0]?.UsageData ??
      product.MarketProperties?.[0]?.UsageDataAggregates ??
      []) as DisplayCatalogUsageData[];

  const snapshots: StoreRatingSnapshot[] = [];
  const today = todayUtc();
  for (const u of usage) {
    const win = windowFromTimeSpan(u.AggregateTimeSpan);
    if (!win) continue;                      // Ignore Unknown / anything Microsoft adds later
    const rc = typeof u.RatingCount === "number" ? u.RatingCount : null;
    const ar = typeof u.AverageRating === "number" ? u.AverageRating : null;
    snapshots.push({
      platform: "xbox",
      captureDate: today,
      sourceEndpoint: ENDPOINT,
      ratingCount: rc,
      avgRating: ar,
      distributionJson: null,                // displaycatalog does not return a distribution
      windowLabel: win,
      isNativeWindow: true,
      skuCount: 1,                           // Xbox bigId is one product; DLC/currency SKUs are separate bigIds
      rawJson: JSON.stringify({ AggregateTimeSpan: u.AggregateTimeSpan, RatingCount: rc, AverageRating: ar }),
    });
  }

  // ─── Pricing → business_model classification ─────────────────────────────
  // Iterate every SKU/availability and collect MSRP values.
  const skuAvail = Array.isArray(product.DisplaySkuAvailabilities) ? product.DisplaySkuAvailabilities : [];
  const msrps: number[] = [];
  let currency: string | null = null;
  for (const dsa of skuAvail) {
    const list = Array.isArray(dsa.Availabilities) ? dsa.Availabilities : [];
    for (const av of list) {
      const p = av.OrderManagementData?.Price;
      if (!p) continue;
      if (typeof p.MSRP === "number") msrps.push(p.MSRP);
      if (!currency && typeof p.CurrencyCode === "string") currency = p.CurrencyCode;
    }
  }
  const allSkusZero = msrps.length > 0 && msrps.every(m => m === 0);
  // Base SKU MSRP heuristic: max non-zero MSRP across SKUs (base tends to be highest single SKU;
  // editions/upgrades are separate SKUs with their own prices).
  const nonZero = msrps.filter(m => m > 0);
  const baseMsrpUsd = nonZero.length > 0 ? Math.max(...nonZero) : (allSkusZero ? 0 : null);
  const baseMsrpUsdCents = baseMsrpUsd == null ? null : Math.round(baseMsrpUsd * 100);

  return {
    snapshots,
    pricing: { allSkusZero, baseMsrpUsdCents, currency },
    productTitle,
  };
}

export async function collectXboxSignals(inputs: XboxCollectorInput[], delayMs: number = 250): Promise<CollectorResult<XboxCollectorOutput>> {
  const ok: XboxCollectorOutput[] = [];
  const failed: CollectorFailure[] = [];
  for (const inp of inputs) {
    try {
      const out = await fetchXboxRatingSignal(inp);
      ok.push(out);
    } catch (e) {
      failed.push({
        platform: "xbox",
        externalSku: inp.bigId,
        reason: e instanceof Error ? e.message : String(e),
        cause: e,
      });
    }
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }
  return { ok, failed };
}
