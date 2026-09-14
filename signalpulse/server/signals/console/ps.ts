/**
 * PlayStation collector — persisted GraphQL wcaProductStarRatingRetrive.
 *
 * Endpoint: https://web.np.playstation.com/api/graphql/v1/op
 * Operation: wcaProductStarRatingRetrive
 * Hash: 799fa113378f699281e0eda3154c54e03d763f6a98ad9a1378d58b1c2cb76cec
 *   (stored in app_settings.PS_PERSISTED_HASH so we can rotate without a deploy)
 *
 * MANDATORY headers (Phase 0 confirmed 2026-09-10):
 *   Accept-Language:               en-US,en;q=0.9   (drives the storefront locale — omit and you get inconsistent counts)
 *   x-apollo-operation-name:       wcaProductStarRatingRetrive
 *   apollo-require-preflight:      true
 *
 * Returns totalRatingsCount + a 5-bucket ratingsDistribution + concept.id.
 * Sony gives us LTD only — no d7/d30 native windows here. Anything shorter
 * must be derived from forward-only snapshot deltas.
 *
 * PDP-HTML fallback on hash rotation: only used when the persisted call
 * returns 400/PersistedQueryNotFound, and it MUST log to signal_source_divergence
 * so we know we drifted. Never silently switch.
 */

import { CollectorFailure, CollectorResult, CollectorSkip, StoreRatingSnapshot, fetchJson, todayUtc } from "./types";

/**
 * Soft-skip sentinel: the endpoint answered, but `productRetrieve` returned
 * null data (delisted / upcoming / unpublished). Runner treats as skipped,
 * NOT failed, so it doesn't inflate on-call metrics or the seed workflow's
 * failure count.
 */
export class PsProductRetrieveEmptyError extends Error {
  constructor(public productId: string) {
    super(`ps productRetrieve returned no data for productId=${productId}`);
    this.name = "PsProductRetrieveEmptyError";
  }
}

const DEFAULT_HASH = "799fa113378f699281e0eda3154c54e03d763f6a98ad9a1378d58b1c2cb76cec";
// Sony's category grid returns a MIX of region-tagged productIds even under
// en-US: `UP` prefix = US region (SIEA/SIEH), `EP` prefix = EU region (SIEE),
// `JP` prefix = Japan, `HP` prefix = Asia. The star-rating persisted query
// rejects a productId whose region does not match the Accept-Language locale
// ("Product not available for [<pid>, US, en]" for EP under en-US), so we
// must send the matching locale per productId prefix or Sony silently drops
// ~25% of the top-100 as no_signal. Verified 2026-09-11: BG3 (EP...) returns
// 110,489 ratings under en-GB and null under en-US; Hogwarts Legacy (EP...)
// returns 118,741 under en-GB and null under en-US.
const LOCALE_BY_REGION: Record<string, string> = {
  UP: "en-US,en;q=0.9",
  EP: "en-GB,en;q=0.9",
  HP: "en-SG,en;q=0.9",
  JP: "ja-JP,ja;q=0.9",
};
const DEFAULT_LOCALE_HEADER = "en-US,en;q=0.9";
// Locales we retry in order when productRetrieve returns null under the
// primary region-derived locale. Handles the rare case where an EP-prefixed
// SKU has been delisted on EU PSN but the US variant is still live under a
// concept-share (or vice versa). Kept short so a genuinely delisted title
// resolves to a soft-skip quickly rather than looping.
const FALLBACK_LOCALES = ["en-GB,en;q=0.9", "en-US,en;q=0.9"];
const ENDPOINT = "ps:wcaProductStarRatingRetrive";
const FALLBACK_ENDPOINT = "ps:pdp-html";

/**
 * Pick the Accept-Language header that matches a Sony productId's regional
 * prefix. Falls back to en-US when the prefix is unknown so we never send an
 * empty locale, which would let Sony's edge decide based on egress IP.
 */
export function localeForPsProductId(productId: string): string {
  const prefix = productId.slice(0, 2).toUpperCase();
  return LOCALE_BY_REGION[prefix] ?? DEFAULT_LOCALE_HEADER;
}

interface PsGraphqlResponse {
  data?: {
    productRetrieve?: {
      id?: string;
      name?: string;
      storeDisplayClassification?: string;
      topCategory?: string;
      concept?: { id?: string };
      starRating?: {
        totalRatingsCount?: number;
        averageRating?: number;
        ratingsDistribution?: {
          fiveStar?: number;
          fourStar?: number;
          threeStar?: number;
          twoStar?: number;
          oneStar?: number;
        };
      };
    };
  };
  errors?: Array<{ message?: string; extensions?: Record<string, unknown> }>;
}

export interface PsCollectorInput {
  titleId: number;
  productId: string;                         // e.g. UP9000-PPSA01413_00-HELLDIVERS200000
  persistedHash?: string;                    // overrideable; falls back to DEFAULT_HASH
  localeHeader?: string;                     // overrideable; falls back to DEFAULT_LOCALE_HEADER
}

export interface PsCollectorOutput {
  /**
   * The input record this output was produced for. The runner MUST read
   * `output.input.titleId` when writing snapshots — do not rely on
   * positional alignment with the original inputs array. Failures and
   * soft-skips remove entries from `ok`, so `ok[i]` no longer lines up
   * with `inputs[i]` after the first skip.
   */
  input: PsCollectorInput;
  snapshot: StoreRatingSnapshot;
  conceptId: string | null;
  storeDisplayClassification: string | null;
  productName: string | null;
  usedFallback: boolean;                     // true → PDP-HTML fallback fired; runner should write divergence row
  /**
   * Release date extracted from the PSN PDP HTML during the daily collector
   * run (YYYY-MM-DD). Null when the PDP fetch failed or the marker was not
   * present. Never blocks the primary rating signal — a PDP failure is
   * silently absorbed, leaving pdpReleaseDate=null. Wired 2026-09-14 to fix
   * the stale-IGDB-release_date failure mode (Onimusha: Way of the Sword
   * PS5, whose IGDB release_date lagged Capcom's Sept-4 launch by 3 weeks
   * and caused the leaderboard's unreleasedFilter to drop the row).
   */
  pdpReleaseDate: string | null;
}

function buildGraphqlUrl(productId: string, hash: string): string {
  const variables = encodeURIComponent(JSON.stringify({ productId }));
  const extensions = encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }));
  return `https://web.np.playstation.com/api/graphql/v1/op?operationName=wcaProductStarRatingRetrive&variables=${variables}&extensions=${extensions}`;
}

/**
 * Build the region-appropriate PSN PDP URL for a Sony productId.
 *
 * PSN's PDP path uses `/en-us/`, `/en-gb/`, etc. — mismatched region locale
 * for a productId prefix would 404. Mirrors the LOCALE_BY_REGION table used
 * by the star-rating call so PDP fetches follow the same region contract.
 */
function buildPsPdpUrl(productId: string): string {
  const prefix = productId.slice(0, 2).toUpperCase();
  const pathLocale =
    prefix === "EP" ? "en-gb" :
    prefix === "HP" ? "en-sg" :
    prefix === "JP" ? "ja-jp" :
    "en-us";
  return `https://store.playstation.com/${pathLocale}/product/${productId}`;
}

/**
 * Fetch the release date from a PSN PDP by scraping the embedded state blob.
 *
 * The PSN PDP HTML contains the Apollo/Next.js state serialized as a JSON
 * blob; inside that blob every product concept carries a `releaseDate` field
 * in ISO-8601 UTC form: `"releaseDate":"2026-09-04T04:00:00Z"`. Verified
 * against Onimusha: Way of the Sword (UP0102-PPSA27836_00) on 2026-09-14.
 *
 * Returns YYYY-MM-DD or null. NEVER throws — a failed PDP fetch or missing
 * marker is soft-fail so the primary rating collector never regresses. The
 * intent is opportunistic: capture the release date when Sony renders it,
 * skip silently when they don't.
 *
 * Uses a 10s timeout (tighter than the 15s GraphQL timeout) so a slow PDP
 * can't stretch each per-title budget past the star-rating call's own SLO.
 */
export async function fetchPsPdpReleaseDate(productId: string): Promise<string | null> {
  const url = buildPsPdpUrl(productId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Anchored to the Apollo-state key. Regex is intentionally strict — we
    // want YYYY-MM-DD followed by a `T` (ISO-8601 time separator) so we
    // never accidentally match a non-date field named similarly. The first
    // occurrence is the product-level releaseDate; PSN sometimes has a
    // duplicate on the concept object and either is authoritative.
    const m = html.match(/"releaseDate":"(\d{4}-\d{2}-\d{2})T/);
    return m ? m[1] : null;
  } catch {
    // AbortError, network failure, non-string body — all soft-fail.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPsRatingSignal(input: PsCollectorInput): Promise<PsCollectorOutput> {
  const hash = input.persistedHash ?? DEFAULT_HASH;
  const primaryLocale = input.localeHeader ?? localeForPsProductId(input.productId);
  const url = buildGraphqlUrl(input.productId, hash);

  // Try the region-matched locale first, then walk FALLBACK_LOCALES if Sony
  // says "Product not available" (data.productRetrieve === null). This is a
  // guardrail against Sony's grid handing us a region-mismatched productId
  // for a particular SKU; the typical case (EP under en-US) is prevented by
  // the primary locale, but the fallback list catches the tail.
  const localesToTry: string[] = [primaryLocale];
  for (const fb of FALLBACK_LOCALES) {
    if (!localesToTry.includes(fb)) localesToTry.push(fb);
  }

  let raw: PsGraphqlResponse | null = null;
  let usedFallback = false;
  let lastError: string | null = null;
  for (const locale of localesToTry) {
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "Accept-Language": locale,
      "x-apollo-operation-name": "wcaProductStarRatingRetrive",
      "apollo-require-preflight": "true",
    };
    try {
      raw = await fetchJson<PsGraphqlResponse>(url, { headers, timeoutMs: 15000 });
      // GraphQL 200 with a PersistedQueryNotFound-style error also means the hash rotated.
      const persistedGone = raw?.errors?.some(e =>
        typeof e?.message === "string" && /PersistedQueryNotFound|Persisted query not found/i.test(e.message)
      );
      if (persistedGone) throw new Error("PS persisted query hash rotated (server-side)");
    } catch (e) {
      // Fallback path: PDP HTML. We DO NOT implement scraping in v1 — we flag it
      // so the runner writes a divergence row and the on-call sees it. Returning
      // the failure keeps the collector honest about what it did (no silent switch).
      const msg = e instanceof Error ? e.message : String(e);
      if (/HTTP 4|PersistedQueryNotFound|persisted/i.test(msg)) {
        usedFallback = true;
        throw new Error(`ps persisted-query failure (fallback required, not yet implemented): ${msg}`);
      }
      throw e;
    }

    if (raw?.data?.productRetrieve) break;
    lastError = raw?.errors?.[0]?.message ?? "productRetrieve returned null";
    // Otherwise try the next locale — Sony returned {data: {productRetrieve: null}}
    // plus an errors[] entry like "Product not available for [<pid>, US, en]".
  }

  const pr = raw?.data?.productRetrieve;
  if (!pr) throw new PsProductRetrieveEmptyError(input.productId);

  const sr = pr.starRating ?? {};
  const rc = typeof sr.totalRatingsCount === "number" ? sr.totalRatingsCount : null;
  const ar = typeof sr.averageRating === "number" ? sr.averageRating : null;
  const dist = sr.ratingsDistribution ?? null;

  const snapshot: StoreRatingSnapshot = {
    platform: "ps5",
    captureDate: todayUtc(),
    sourceEndpoint: usedFallback ? FALLBACK_ENDPOINT : ENDPOINT,
    ratingCount: rc,
    avgRating: ar,
    distributionJson: dist ? JSON.stringify(dist) : null,
    windowLabel: "ltd",                      // PS never returns short windows
    isNativeWindow: true,
    skuCount: 1,                             // PS collapses per productId; concept-level rollup handled at map layer
    rawJson: JSON.stringify({
      storeDisplayClassification: pr.storeDisplayClassification ?? null,
      totalRatingsCount: rc,
      averageRating: ar,
    }),
  };

  // Opportunistic PDP release-date capture. Runs AFTER the primary signal
  // is committed to `snapshot`, so any PDP failure cannot affect the rating
  // ingestion. Timeout is bounded inside fetchPsPdpReleaseDate — never throws.
  const pdpReleaseDate = await fetchPsPdpReleaseDate(input.productId);

  return {
    input,
    snapshot,
    conceptId: pr.concept?.id ?? null,
    storeDisplayClassification: pr.storeDisplayClassification ?? null,
    productName: pr.name ?? null,
    usedFallback,
    pdpReleaseDate,
  };
}

export async function collectPsSignals(inputs: PsCollectorInput[], delayMs: number = 300): Promise<CollectorResult<PsCollectorOutput>> {
  const ok: PsCollectorOutput[] = [];
  const failed: CollectorFailure[] = [];
  const skipped: CollectorSkip[] = [];
  for (const inp of inputs) {
    try {
      const out = await fetchPsRatingSignal(inp);
      ok.push(out);
    } catch (e) {
      // Soft-skip: delisted / unpublished / upcoming editions still surface
      // on the sales chart but have no PDP data. Not a system failure.
      if (e instanceof PsProductRetrieveEmptyError) {
        skipped.push({
          platform: "ps5",
          externalSku: inp.productId,
          reason: "productRetrieve returned no data (likely delisted or upcoming)",
        });
      } else {
        failed.push({
          platform: "ps5",
          externalSku: inp.productId,
          reason: e instanceof Error ? e.message : String(e),
          cause: e,
        });
      }
    }
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }
  return { ok, failed, skipped };
}
