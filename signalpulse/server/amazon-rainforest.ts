/**
 * Amazon Retail — Rainforest API client + software-only filter.
 *
 * All Rainforest calls funnel through `rainforestRequest()` so credit
 * accounting is uniform. The API key is resolved at call time from the
 * `app_settings` row `rainforest_api_key` (see storage.seedDefaultSettings),
 * with a `RAINFOREST_API_KEY` env-var fallback for local dev. The raw key is
 * NEVER committed to source — see CLAUDE.md § "SignalPulse — API Key Storage
 * Convention".
 *
 * The software-only filter is applied *before* the caller sees any rows: it
 * excludes hardware, peripherals, memberships, gift cards, cables, cases,
 * etc. while whitelisting titles that (a) match a tracked franchise token or
 * (b) contain both a filter word AND an unambiguous software hint
 * ("Edition", "Deluxe", …) so real games survive. Filtered rows are counted
 * for observability but discarded; the caller keeps only the top-N software
 * items with contiguous ranks 1..N and `rawRank` preserved for audit.
 */
import { storage } from "./storage";
import { AMAZON_CHART_NODES, type AmazonPlatformSlug } from "@shared/schema";

const RAINFOREST_BASE = "https://api.rainforestapi.com/request";

function getRainforestKey(): string | null {
  const dbVal = storage.getSetting("rainforest_api_key")?.value?.trim();
  if (dbVal) return dbVal;
  const envVal = process.env.RAINFOREST_API_KEY?.trim();
  return envVal || null;
}

export function isRainforestConfigured(): boolean {
  return !!getRainforestKey();
}

// ─── Software-only filter (games, not hardware/peripherals) ─────────────────
// Excludes: controllers, headsets, consoles, cables, cases, subscriptions,
// gift cards, remotes, etc. Whitelist protects titles that contain filter
// words but are actually games (e.g. "Grand Theft Auto V — Premium Edition"
// survives despite "Edition"; a known franchise from our tracked map always
// survives).

// HARD EXCLUSIONS: these categories are NEVER games, no software-hint
// override applies. A "DualSense Wireless Controller — Limited Edition" is
// still a controller; a "PS5 Digital Edition" is still a console; a
// "$10 PlayStation Store Gift Card [Digital Code]" is still a gift card.
// The whitelist below only helps when the filter word is genuinely
// ambiguous (e.g. "stand", "case", "grip", "skin", "remote", "battery") —
// hardware categories that a real game title might harmlessly contain.
const HARD_EXCLUDE_WORDS = [
  "controller", "headset", "console", "gift card", "charger", "charging",
  "membership", "subscription", "cable", "cover plate", "faceplate",
  "steering wheel", "arcade stick", "fight stick", "screen protector",
  "dock", "adapter", "docking station",
];

// SOFT EXCLUSIONS: hardware/accessory words that can appear in legitimate
// game titles. Excluded unless a software hint is present.
const SOFT_FILTER_WORDS = [
  "stand", "case", "grip", "skin", "sticker", "decal", "carrying case",
  "remote", "battery",
];

// "Bundle" is tricky: many game bundles are software. Only exclude when the
// bundle title is clearly hardware (e.g. "Console Bundle").
const HARDWARE_BUNDLE_PATTERNS = [
  /console bundle/i, /controller bundle/i, /headset bundle/i,
];

// Console SKU patterns — Amazon lists consoles inside the "Games & Accessories"
// browse nodes with titles that don't contain the word "console" (e.g.
// "PlayStation®5 Digital Edition – 825GB", "Xbox Series X 1TB"). These are
// hardware and must be dropped regardless of software hints.
const CONSOLE_SKU_PATTERNS = [
  /playstation\W*®?\W*5\s+(?:digital\s+)?(?:edition|console|slim|pro)/i,
  /^\s*playstation\W*®?\W*5\s+(?:digital\s+)?(?:edition|slim|pro)?\s*–?\s*\d+\s*gb/i,
  /\bps5\s+(?:digital\s+)?(?:edition|console|slim|pro)\b/i,
  /xbox\s+series\s+[xs]\s+\d+\s*tb/i,
  /xbox\s+series\s+[xs]\s+console/i,
  /nintendo\s+switch\s+2?\s*(?:oled|lite)?\s+console/i,
  /nintendo\s+switch\s+2?\s+\d+\s*gb\s+console/i,
];

const SOFTWARE_HINTS = [
  "edition", "deluxe", "standard", "collector", "physical",
  "game of the year", "goty", "definitive", "complete", "gold edition",
  "premium edition", "ultimate edition",
];

export function isVideoGameSoftware(
  title: string,
  trackedFranchiseTokens: string[] = [],
): { keep: boolean; reason?: string } {
  const t = (title || "").toLowerCase();
  // Hard hardware-bundle exclusion — always drops, even for tracked franchises
  // (a "Wolverine Console Bundle" is still a console, even if "Wolverine" is tracked).
  for (const p of HARDWARE_BUNDLE_PATTERNS) {
    if (p.test(title)) return { keep: false, reason: "hardware_bundle" };
  }
  // Console SKU patterns — catch consoles that don't contain the literal
  // word "console" (e.g. "PlayStation 5 Digital Edition – 825GB").
  for (const p of CONSOLE_SKU_PATTERNS) {
    if (p.test(title)) return { keep: false, reason: "console_sku" };
  }
  // Hard exclusions — controllers, consoles, headsets, gift cards, etc.
  // No override; these categories are never games.
  for (const w of HARD_EXCLUDE_WORDS) {
    if (t.includes(w)) return { keep: false, reason: `hardware:${w}` };
  }
  // Whitelist for tracked franchises applies only *past* the hard exclusions.
  for (const f of trackedFranchiseTokens) {
    if (f && t.includes(f.toLowerCase())) return { keep: true };
  }
  // Soft-filter exclusion (unless title has a software hint like "Edition").
  for (const w of SOFT_FILTER_WORDS) {
    if (t.includes(w)) {
      const hasSoftwareHint = SOFTWARE_HINTS.some((h) => t.includes(h));
      if (!hasSoftwareHint) return { keep: false, reason: `soft_filter:${w}` };
    }
  }
  return { keep: true };
}

// ─── API endpoints ──────────────────────────────────────────────────────────
// All return { data, creditsUsed, creditsRemaining } for the caller to log.

export interface RainforestCallResult<T> {
  data: T;
  creditsUsed: number;
  creditsRemaining: number;
}

async function rainforestRequest<T>(params: Record<string, string>): Promise<RainforestCallResult<T>> {
  const apiKey = getRainforestKey();
  if (!apiKey) {
    throw new Error(
      "rainforest_api_key is not set (Settings page or RAINFOREST_API_KEY env var)",
    );
  }
  const url = new URL(RAINFOREST_BASE);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("output", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Rainforest ${res.status}: ${body.slice(0, 200)}`);
  }
  const json: any = await res.json();
  return {
    data: json as T,
    creditsUsed: json?.request_info?.credits_used ?? 0,
    creditsRemaining: json?.request_info?.credits_remaining ?? 0,
  };
}

// fetchBestsellersRaw returns Amazon's raw ordered list for a platform (top ~50).
export async function fetchBestsellersRaw(platform: AmazonPlatformSlug): Promise<RainforestCallResult<any>> {
  const node = AMAZON_CHART_NODES[platform];
  return rainforestRequest({ type: "bestsellers", url: node.url });
}

// Public: fetch, filter, and return the top-N software-only chart with
// rawRank preserved. Caller writes to amazonChartSnapshots.
export interface ChartRow {
  rank: number;         // contiguous 1..N after software filter
  rawRank: number;      // Amazon's original rank
  asin: string;
  title: string;
  price: number | null;
  rating: number | null;
  ratingsTotal: number | null;
  imageUrl: string | null;
  link: string | null;
}

export async function fetchSoftwareChart(
  platform: AmazonPlatformSlug,
  trackedFranchiseTokens: string[] = [],
  limit = 50,
): Promise<{ rows: ChartRow[]; creditsUsed: number; creditsRemaining: number; excluded: number }> {
  const result = await fetchBestsellersRaw(platform);
  const bestsellers: any[] = result.data?.bestsellers ?? [];
  let excluded = 0;
  const kept: ChartRow[] = [];
  for (const b of bestsellers) {
    const title = (b.title ?? "").toString();
    const check = isVideoGameSoftware(title, trackedFranchiseTokens);
    if (!check.keep) { excluded += 1; continue; }
    if (kept.length >= limit) break;
    const priceRaw = b.price;
    const price = typeof priceRaw === "number" ? priceRaw : (priceRaw?.value ?? null);
    kept.push({
      rank: kept.length + 1,
      rawRank: b.rank ?? kept.length + 1,
      asin: (b.asin ?? "").toString(),
      title,
      price,
      rating: b.rating ?? null,
      ratingsTotal: b.ratings_total ?? null,
      imageUrl: b.image ?? null,
      link: b.link ?? null,
    });
  }
  return {
    rows: kept,
    creditsUsed: result.creditsUsed,
    creditsRemaining: result.creditsRemaining,
    excluded,
  };
}

// fetchProduct — used by Buy Box daily pull AND Also-Bought weekly pull.
export async function fetchProduct(asin: string): Promise<RainforestCallResult<any>> {
  return rainforestRequest({ type: "product", asin, amazon_domain: "amazon.com" });
}

// fetchProductByUrl — QA-GATE-3 probe added 2026-09-07 to test whether
// Rainforest returns richer recommendation carousels when the ASIN is
// passed as a canonical /dp/ URL instead of via the `asin` parameter.
export async function fetchProductByUrl(asin: string): Promise<RainforestCallResult<any>> {
  return rainforestRequest({ type: "product", url: `https://www.amazon.com/dp/${asin}` });
}

// fetchAlsoBought — QA-GATE-1 probe added 2026-09-07 to verify Rainforest's
// dedicated `type=also_bought` endpoint returns non-empty recommendation
// arrays for game ASINs before we cut runAlsoBoughtDaily over to it.
// Response shape per Rainforest docs: `{ request_info, also_bought: [ { asin,
// title, image, link, rating?, ratings_total?, price? }, ... ] }`.
export async function fetchAlsoBought(asin: string): Promise<RainforestCallResult<any>> {
  return rainforestRequest({ type: "also_bought", asin, amazon_domain: "amazon.com" });
}

// fetchFormatsEditions — Rainforest `type=formats_editions`. Returns every
// format/edition variant of the given ASIN as listed on Amazon's own
// variant carousel. This is the RIGHT tool for finding cross-platform
// siblings of a known game SKU (e.g. given the PS5 ASIN, get Xbox / Switch
// / Digital editions) because Amazon links these together directly rather
// than requiring us to guess via keyword search.
//
// Response shape (per Rainforest docs):
//   { formats_editions: [ { format?: string, title?: string, asin?: string,
//                           link?: string, is_current_product?: boolean, ... }, ... ] }
export async function fetchFormatsEditions(asin: string): Promise<RainforestCallResult<any>> {
  return rainforestRequest({ type: "formats_editions", asin, amazon_domain: "amazon.com" });
}

// fetchSalesEstimation — Rainforest `type=sales_estimation`. Given an ASIN,
// returns an internal-model estimate of weekly + monthly units sold, based
// on BSR + category signals. Returns null-populated `sales_estimation` with
// has_sales_estimation=false when there is not enough data (no BSR, rank
// too low, pre-order). Costs 1 credit per call per Rainforest docs.
export async function fetchSalesEstimation(asin: string): Promise<RainforestCallResult<any>> {
  return rainforestRequest({ type: "sales_estimation", asin, amazon_domain: "amazon.com" });
}

// Extract the "bought in past .." label from a product response, handling
// the two shapes Rainforest may emit (top-level string or object with a
// `text` field). Returns null when Amazon isn't showing the label for this
// SKU — that's the common case for low-velocity / pre-order items.
export function extractRecentSales(productJson: any): string | null {
  const p = productJson?.product ?? productJson ?? {};
  const candidates: Array<unknown> = [
    p.recent_sales,
    p.buybox_winner?.recent_sales,
    p.summarization_attributes?.recent_sales,
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === "string" && c.trim()) return c.trim();
    if (typeof c === "object") {
      const anyC = c as any;
      const s = anyC.text ?? anyC.value ?? anyC.label ?? anyC.raw;
      if (typeof s === "string" && s.trim()) return s.trim();
    }
  }
  return null;
}

// Extracts up to `limit` also_bought recommendations from a product response.
export interface AlsoBoughtRow {
  rankPosition: number;
  recommendedAsin: string;
  title: string;
  price: number | null;
  rating: number | null;
  ratingsTotal: number | null;
  imageUrl: string | null;
  link: string | null;
}

export function extractAlsoBought(productJson: any, limit = 5): AlsoBoughtRow[] {
  const cands: any[] =
    productJson?.product?.also_bought
    ?? productJson?.also_bought
    ?? productJson?.product?.frequently_bought_together
    ?? [];
  const out: AlsoBoughtRow[] = [];
  for (const c of cands) {
    if (out.length >= limit) break;
    const priceRaw = c.price;
    const price = typeof priceRaw === "number" ? priceRaw : (priceRaw?.value ?? null);
    out.push({
      rankPosition: out.length + 1,
      recommendedAsin: (c.asin ?? "").toString(),
      title: (c.title ?? "").toString(),
      price,
      rating: c.rating ?? null,
      ratingsTotal: c.ratings_total ?? null,
      imageUrl: c.image ?? null,
      link: c.link ?? null,
    });
  }
  return out;
}

// ─── Reviews (v3.36, 2026-09-07) ────────────────────────────────────
// Rainforest `type=reviews` returns up to ~10 reviews per call, newest
// first when `sort_by=most_recent`. We keep this to 1 page per ASIN per
// fetch — the PDP wants "top / newest", not exhaustive back-fill — so
// each call costs 1 credit. For the daily PDP hydrator we call once per
// pinned ASIN (Saber + competitor) on the same 08:00 slot as also-bought.

export async function fetchReviews(
  asin: string,
  opts?: { sortBy?: "most_recent" | "most_helpful" | "top_reviews"; page?: number },
): Promise<RainforestCallResult<any>> {
  const params: Record<string, string> = {
    type: "reviews",
    asin,
    amazon_domain: "amazon.com",
    sort_by: opts?.sortBy ?? "most_recent",
  };
  if (opts?.page && opts.page > 1) params.page = String(opts.page);
  return rainforestRequest(params);
}

export interface ReviewRow {
  reviewId: string;
  title: string | null;
  body: string | null;
  rating: number | null;
  reviewDate: string | null;
  verifiedPurchase: boolean | null;
  helpfulVotes: number | null;
  reviewerName: string | null;
  variantAttrs: Array<{ name: string; value: string }> | null;
  imageUrls: string[] | null;
}

export function extractReviews(reviewsJson: any, limit = 20): ReviewRow[] {
  const cands: any[] = reviewsJson?.reviews ?? reviewsJson?.top_reviews ?? [];
  const out: ReviewRow[] = [];
  for (const r of cands) {
    if (out.length >= limit) break;
    if (!r?.id) continue;
    const dateRaw = r.date;
    const reviewDate = typeof dateRaw === "string"
      ? dateRaw
      : (dateRaw?.utc ?? dateRaw?.raw ?? null);
    const helpful = (() => {
      const v = r.helpful_votes;
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const m = v.match(/(\d+)/);
        return m ? Number(m[1]) : null;
      }
      return null;
    })();
    const variantAttrs: Array<{ name: string; value: string }> | null = Array.isArray(r.attributes)
      ? r.attributes
          .filter((a: any) => a && typeof a.name === "string")
          .map((a: any) => ({ name: String(a.name), value: String(a.value ?? "") }))
      : null;
    const imageUrls: string[] | null = Array.isArray(r.images)
      ? r.images.map((im: any) => (typeof im === "string" ? im : im?.link ?? im?.image ?? null)).filter((x: any): x is string => typeof x === "string")
      : null;
    out.push({
      reviewId: String(r.id),
      title: r.title ? String(r.title) : null,
      body: r.body ? String(r.body) : null,
      rating: typeof r.rating === "number" ? r.rating : null,
      reviewDate,
      verifiedPurchase: typeof r.verified_purchase === "boolean" ? r.verified_purchase : null,
      helpfulVotes: helpful,
      reviewerName: r.profile?.name ? String(r.profile.name) : (r.reviewer ? String(r.reviewer) : null),
      variantAttrs: variantAttrs && variantAttrs.length ? variantAttrs : null,
      imageUrls: imageUrls && imageUrls.length ? imageUrls : null,
    });
  }
  return out;
}

// fetchMoversAndShakers — bestseller_type=movers_and_shakers.
export async function fetchMovers(platform: AmazonPlatformSlug): Promise<RainforestCallResult<any>> {
  const node = AMAZON_CHART_NODES[platform];
  return rainforestRequest({
    type: "bestsellers",
    bestseller_type: "movers_and_shakers",
    url: node.url,
  });
}

// fetchNewReleases — bestseller_type=new_releases.
export async function fetchNewReleases(platform: AmazonPlatformSlug): Promise<RainforestCallResult<any>> {
  const node = AMAZON_CHART_NODES[platform];
  return rainforestRequest({
    type: "bestsellers",
    bestseller_type: "new_releases",
    url: node.url,
  });
}

// fetchSearch — keyword tracker for Search SOV.
// Optional `categoryId` scopes the search to a specific Amazon browse node
// (e.g. the PS5/Xbox/Switch bestseller nodes) so we don't pick up cross-
// platform SKUs when discovering ASINs by title.
export async function fetchSearch(
  keyword: string,
  categoryId?: string,
): Promise<RainforestCallResult<any>> {
  const params: Record<string, string> = {
    type: "search",
    search_term: keyword,
    amazon_domain: "amazon.com",
  };
  if (categoryId) params.category_id = categoryId;
  return rainforestRequest(params);
}
