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

const FILTER_WORDS = [
  "controller", "headset", "console", "charger", "charging", "stand",
  "case", "cover plate", "faceplate", "cable", "membership", "subscription",
  "gift card", "steering wheel", "arcade stick", "fight stick", "grip",
  "screen protector", "dock", "adapter", "remote", "battery",
  "skin", "sticker", "decal", "carrying case",
];

// "Bundle" is tricky: many game bundles are software. Only exclude when the
// bundle title is clearly hardware (e.g. "Console Bundle").
const HARDWARE_BUNDLE_PATTERNS = [
  /console bundle/i, /controller bundle/i, /headset bundle/i,
];

const SOFTWARE_HINTS = [
  "edition", "deluxe", "standard", "collector", "digital", "physical",
  "game of the year", "goty", "definitive", "complete", "gold edition",
  "premium edition", "ultimate edition",
];

export function isVideoGameSoftware(
  title: string,
  trackedFranchiseTokens: string[] = [],
): { keep: boolean; reason?: string } {
  const t = (title || "").toLowerCase();
  // Whitelist: known franchise wins even if a filter word appears
  for (const f of trackedFranchiseTokens) {
    if (f && t.includes(f.toLowerCase())) return { keep: true };
  }
  // Hard hardware-bundle exclusion
  for (const p of HARDWARE_BUNDLE_PATTERNS) {
    if (p.test(title)) return { keep: false, reason: "hardware_bundle" };
  }
  // Filter word exclusion (unless it also has a software hint like "Edition")
  for (const w of FILTER_WORDS) {
    if (t.includes(w)) {
      const hasSoftwareHint = SOFTWARE_HINTS.some((h) => t.includes(h));
      if (!hasSoftwareHint) return { keep: false, reason: `filter_word:${w}` };
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
export async function fetchSearch(keyword: string): Promise<RainforestCallResult<any>> {
  return rainforestRequest({ type: "search", search_term: keyword, amazon_domain: "amazon.com" });
}
