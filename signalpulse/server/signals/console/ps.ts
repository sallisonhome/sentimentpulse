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
const DEFAULT_LOCALE_HEADER = "en-US,en;q=0.9";
const ENDPOINT = "ps:wcaProductStarRatingRetrive";
const FALLBACK_ENDPOINT = "ps:pdp-html";

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
}

function buildGraphqlUrl(productId: string, hash: string): string {
  const variables = encodeURIComponent(JSON.stringify({ productId }));
  const extensions = encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }));
  return `https://web.np.playstation.com/api/graphql/v1/op?operationName=wcaProductStarRatingRetrive&variables=${variables}&extensions=${extensions}`;
}

export async function fetchPsRatingSignal(input: PsCollectorInput): Promise<PsCollectorOutput> {
  const hash = input.persistedHash ?? DEFAULT_HASH;
  const locale = input.localeHeader ?? DEFAULT_LOCALE_HEADER;
  const url = buildGraphqlUrl(input.productId, hash);

  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Accept-Language": locale,
    "x-apollo-operation-name": "wcaProductStarRatingRetrive",
    "apollo-require-preflight": "true",
  };

  let raw: PsGraphqlResponse | null = null;
  let usedFallback = false;
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

  return {
    input,
    snapshot,
    conceptId: pr.concept?.id ?? null,
    storeDisplayClassification: pr.storeDisplayClassification ?? null,
    productName: pr.name ?? null,
    usedFallback,
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
