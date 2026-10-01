// Pure shared-rating-pool rules for the console leaderboards (no database access).

/**
 * PS5/Xbox SKUs of one concept share one store rating pool: the same rating count and average, captured
 * a moment apart so the counts can differ by a few ratings. Rows on the same platform in one pool are one
 * body of sales, so only one of them is summed, even when their names differ (Minecraft and its
 * Collection SKUs, GTA V and GTA Online). Counts within 1 + 0.002% match; different names link only at 1,000+ ratings
 * with the same release date or the same leading two words, so unrelated titles that match by chance (Xbox Mortal Shell II and
 * Mortal Kombat 11 both at 1,170 ratings and 4.3) never merge; smaller pools need the same edition-family key. Preference: a verified positive
 * anchor, then a row measured in the requested window (not a cascaded or bootstrap fallback), then a priced SKU
 * (so the family keeps its revenue), then the earliest release, then higher revenue, then lower id. Titles with a verified zero
 * anchor (an operator's manual de-duplication) are left alone, and several anchored titles in one pool
 * all stay. Dropped rows remain listed as editions of the primary's family.
 */
export function pickSharedPoolPrimaries<R extends { titleId: number; unitsMid?: number | null; ratingCount?: number | null; avgRating?: number | null;
  windowUsed?: string | null; estimateMethod?: string | null; releaseDate?: string | null; msrpUsdCents?: number | null;
  revenueMidUsd?: number | null; name?: string | null }>(
  rows: R[], platform: string, window: string, keyFor: (name: string) => string,
  anchors: { positive: Set<number>; zero: Set<number> } = { positive: new Set(), zero: new Set() },
): { kept: R[]; dropped: R[]; primaryOf: Map<number, number> } {
  const primaryOf = new Map<number, number>();
  if (platform === "steam") return { kept: rows, dropped: [], primaryOf };
  const cand = rows.filter(r => typeof r.ratingCount === "number" && r.ratingCount >= 100 && !anchors.zero.has(r.titleId))
    .sort((a, b) => (a.ratingCount as number) - (b.ratingCount as number));
  const clusters: R[][] = [];
  for (const r of cand) {
    const last = clusters[clusters.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && prev.avgRating === r.avgRating &&
        (r.ratingCount as number) - (prev.ratingCount as number) <= 1 + 2e-5 * (prev.ratingCount as number)) last.push(r);
    else clusters.push([r]);
  }
  const pools: R[][] = [];
  const words = (r: R) => ((r.name ?? "") as string).toLowerCase().replace(/[^a-z0-9\u00C0-\uFFFF]+/g, " ").trim().split(" ").filter(Boolean);
  const sharedLead = (a: R, b: R) => {
    const x = words(a), y = words(b);
    let n = 0;
    while (n < x.length && n < y.length && x[n] === y[n]) n++;
    return n >= Math.min(2, x.length, y.length) && n >= 1 && x[0].length >= 3;
  };
  const related = (a: R, b: R) => {
    const ka = keyFor((a.name ?? "") as string);
    if (ka.length >= 2 && ka === keyFor((b.name ?? "") as string)) return true;
    // Different names link only at 1,000+ ratings and with a second sign of the same concept.
    if ((a.ratingCount as number) < 1000) return false;
    return Boolean(a.releaseDate && a.releaseDate === b.releaseDate) || sharedLead(a, b);
  };
  for (const c of clusters) {
    if (c.length < 2) continue;
    const parent = c.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) if (related(c[i], c[j])) parent[find(j)] = find(i);
    const comps = new Map<number, R[]>();
    c.forEach((r, i) => (comps.get(find(i)) ?? comps.set(find(i), []).get(find(i))!).push(r));
    for (const v of Array.from(comps.values())) if (v.length > 1) pools.push(v);
  }
  const dropped = new Set<R>();
  for (const members of pools) {
    const measured = (r: R) => (r.windowUsed === window && r.estimateMethod !== "backfill-bootstrap" ? 1 : 0);
    const anchored = (r: R) => (anchors.positive.has(r.titleId) ? 1 : 0);
    const rel = (r: R) => (r.releaseDate && /^\d{4}-\d{2}-\d{2}/.test(r.releaseDate) ? r.releaseDate : "9999-12-31");
    const ordered = members.slice().sort((a, b) =>
      anchored(b) - anchored(a) ||
      measured(b) - measured(a) ||
      ((b.msrpUsdCents != null ? 1 : 0) - (a.msrpUsdCents != null ? 1 : 0)) ||
      (rel(a) < rel(b) ? -1 : rel(a) > rel(b) ? 1 : 0) ||
      ((b.revenueMidUsd ?? 0) - (a.revenueMidUsd ?? 0)) ||
      a.titleId - b.titleId);
    for (const r of ordered.slice(1)) {
      if (anchored(r)) continue;
      dropped.add(r);
      primaryOf.set(r.titleId, ordered[0].titleId);
    }
  }
  return { kept: rows.filter(r => !dropped.has(r)), dropped: rows.filter(r => dropped.has(r)), primaryOf };
}

/**
 * Output invariant for the shared-pool rule: after grouping, no two displayed rows on a PS5/Xbox board may
 * be one rating pool, unless both are verified-anchored ("actual"). Returns the offending pairs so the
 * route can log them and tests/audits can fail on them.
 */
export function sharedPoolViolations<R extends { titleId: number; ratingCount?: number | null; avgRating?: number | null;
  releaseDate?: string | null; name?: string | null; dataSource?: string | null }>(
  rows: R[], platform: string, keyFor: (name: string) => string): Array<[number, number]> {
  const actual = new Set(rows.filter(r => r.dataSource === "actual").map(r => r.titleId));
  const { dropped, primaryOf } = pickSharedPoolPrimaries(rows as any[], platform, "ltd", keyFor, { positive: actual, zero: new Set() });
  return dropped.map(d => [d.titleId, primaryOf.get(d.titleId)!] as [number, number]);
}
