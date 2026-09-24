import type { CriticRating } from "../shared/reviews-ratings";

// Do not strip subtitles, "remake", "remastered", demos, passes or editions.
// Punctuation/trademarks are presentation, but words and numbers are identity.
export function ratingIdentity(name: string): string {
  return name.replace(/[™®℗℠]/g, "").replace(/Δ|δ/g, "Delta").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
}

/** Strip storefront packaging, not game identity. Remasters/complete/definitive
 * editions and all subtitles remain distinct. The provider's detail record
 * must still pass exact name + Steam ID/release-date verification. */
export function criticSearchTitle(name: string): string {
  let value = name.replace(/[™®℗℠]/g, "").replace(/Δ|δ/g, "Delta")
    .replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  const suffix = /(?:\s*[:(\-[\]]\s*|\s+)(?:(?:digital |premium )?(?:standard|deluxe|ultimate|gold|premium) edition|digital deluxe|ps[45]\s*(?:&|and)\s*ps[45]|(?:for )?ps[45](?: version)?|xbox one\s*(?:&|and)\s*xbox series x[|/]s|xbox series x[|/]s|xbox one)(?:[)\]])?$/i;
  for (let i = 0; i < 8; i++) {
    const next = value.replace(suffix, "").trim();
    if (!next || next === value) break;
    value = next;
  }
  // EA brands these entries on OpenCritic; console storefronts omit the brand.
  if (/^UFC\s+\d+$/i.test(value)) value = `EA Sports ${value}`;
  return value;
}

function criticNameMatches(actual: string, expected: string, releaseDates: string[]) {
  if (ratingIdentity(actual) === ratingIdentity(expected)) return true;
  const dated = actual.match(/^(.*?)\s+\((\d{4})\)$/);
  return !!dated && ratingIdentity(dated[1]) === ratingIdentity(expected)
    && releaseDates.some(date => Number.isFinite(Date.parse(date))
      && new Date(date).getUTCFullYear() === Number(dated[2]));
}
export function score(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? value : null;
}

export function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeCritics(raw: any): Omit<CriticRating, "status" | "provider" | "capturedAt"> {
  if (!raw || !Number.isSafeInteger(raw.id) || raw.id <= 0 || typeof raw.name !== "string") {
    throw new Error("invalid_provider_response");
  }
  const reviewCount = count(raw.review_count);
  // No reviews is not a zero score. Preserve genuine zero with reviews.
  const eligible = reviewCount !== 0;
  return {
    id: raw.id, name: raw.name,
    url: `https://opencritic.com/game/${raw.id}`,
    criticsRecommend: eligible ? score(raw.percent_recommended, 100) : null,
    topCriticScore: eligible ? score(raw.top_critic_score, 100) : null,
    rating: eligible && ["Mighty", "Strong", "Fair", "Weak"].includes(raw.tier) ? raw.tier : null,
    reviewCount,
  };
}

export function exactCandidates(search: any, name: string, releaseDates: string[] = []): Array<{ id: number; name: string }> {
  if (!search || !Array.isArray(search.results)) throw new Error("invalid_search_response");
  const unique = new Map<number, { id: number; name: string }>();
  for (const row of search.results) {
    if (row?.type === "game" && Number.isSafeInteger(row.id) && row.id > 0
      && typeof row.name === "string" && criticNameMatches(row.name, name, releaseDates)) {
      unique.set(row.id, row);
    }
  }
  return Array.from(unique.values());
}

export function exactCandidate(search: any, name: string): { id: number; name: string } | null {
  const candidates = exactCandidates(search, name);
  if (candidates.length > 1) throw new Error("ambiguous");
  return candidates[0] ?? null;
}

export function verifyCriticIdentity(raw: any, name: string, releaseDate: string | null, steamAppId: string | null, releaseDates: string[] = []): boolean {
  const expectedDates = Array.from(new Set([releaseDate, ...releaseDates].filter((d): d is string => !!d)));
  if (typeof raw?.name !== "string" || !criticNameMatches(raw.name, name, expectedDates)) return false;
  if (raw.steam_id != null && steamAppId != null) return String(raw.steam_id) === steamAppId;
  // Names reused by remakes need a release-date check. Accept documented
  // platform-specific release dates too, so later ports don't fail needlessly.
  const expected = expectedDates.map(Date.parse).filter(Number.isFinite);
  if (!expected.length) return false;
  const dates = [raw.release_date, ...(Array.isArray(raw.platforms) ? raw.platforms.map((p: any) => p?.release_date) : [])];
  return dates.some(d => typeof d === "string" && Number.isFinite(Date.parse(d))
    && expected.some(e => Math.abs(Date.parse(d) - e) <= 370 * 86400_000));
}

export function steamSummary(raw: any) {
  const q = raw?.query_summary;
  if (raw?.success !== 1 || !q || count(q.total_positive) == null || count(q.total_negative) == null
    || count(q.total_reviews) == null || q.total_positive + q.total_negative !== q.total_reviews) {
    throw new Error("invalid_steam_response");
  }
  return {
    value: q.total_reviews > 0 ? q.total_positive / q.total_reviews * 100 : null,
    count: q.total_reviews,
    description: typeof q.review_score_desc === "string" ? q.review_score_desc : null,
  };
}

/** Verify the embedded App ID, not the response envelope's presentation key. */
export function steamAppDetails(raw: any, appId: string) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_steam_metadata");
  const matches = Object.values(raw).filter((entry: any) =>
    (entry?.success === true || entry?.success === 1) && String(entry?.data?.steam_appid) === appId) as any[];
  const direct = raw[appId];
  if (direct?.success === false || direct?.success === 0) {
    if (matches.length) throw new Error("invalid_steam_identity");
    return null;
  }
  if (direct && String(direct?.data?.steam_appid) !== appId) throw new Error("invalid_steam_identity");
  if (matches.length !== 1 || typeof matches[0].data.name !== "string" || !matches[0].data.name.trim()) {
    throw new Error("invalid_steam_identity");
  }
  return matches[0].data;
}
