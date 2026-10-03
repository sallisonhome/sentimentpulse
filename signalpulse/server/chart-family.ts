// Chart-only family resolution for /api/console/titles/:id/revenue-daily.
//
// The leaderboards join platforms by editionGroupKey and then overlay console rows from Steam.
// Joining a new store spelling there would replace that console row's native estimate, so
// spellings that only differ by numeral style are bridged HERE, for the PDP chart only.
// The chart reads each platform's own native lifetime estimate day over day; nothing in this
// file changes a board value, an estimate or an anchor.
//
// Exact reviewed pairs only; never a generic "II = 2" rule (sequel identity stays elsewhere).
import type Database from "better-sqlite3";

const CHART_FAMILY_ALIASES: Record<string, string> = {
  "warhammer 40,000: space marine 2": "warhammer 40,000: space marine ii", // Xbox store spelling
};

export function chartFamilyKey(editionKey: string): string {
  return CHART_FAMILY_ALIASES[editionKey] ?? editionKey;
}

/**
 * Collapse same-platform listings that carry the SAME native estimate. Two store listings of
 * one platform (regional PS5 SKUs) can hold identical lifetime units on every shared day; the
 * chart then sees every day as "ambiguous" and the line drops out. Only a pair whose shared,
 * valued days all agree is collapsed. A pair that disagrees on any shared day is a genuine
 * conflict and both stay, so the route's existing ambiguity rule (null from that day) applies
 * unchanged. Rank: a priced base SKU, then the most recent native lifetime estimate with a
 * value, then the lowest id. The requested id wins ties on its own platform.
 */
export function canonicalSiblings(
  db: Database.Database,
  ids: Array<{ titleId: number; platform: string }>,
  requested: number,
): number[] {
  const byPlatform = new Map<string, number[]>();
  for (const r of ids) byPlatform.set(r.platform, [...(byPlatform.get(r.platform) ?? []), r.titleId]);
  const keep: number[] = [];
  for (const [platform, list] of Array.from(byPlatform)) {
    if (list.length === 1) { keep.push(list[0]); continue; }
    const series = (id: number) => new Map((db.prepare(`SELECT as_of_date AS d, units_mid AS u FROM window_estimates_daily
      WHERE title_id=? AND platform=? AND window='ltd' AND units_mid IS NOT NULL`).all(id, platform) as Array<{ d: string; u: number }>).map(r => [r.d, r.u]));
    const agree = (a: number, b: number) => {
      const sa = series(a), sb = series(b);
      let shared = 0;
      for (const [d, u] of Array.from(sa)) if (sb.has(d)) { shared++; if (sb.get(d) !== u) return false; }
      return shared > 0;
    };
    if (!list.every((x, i) => list.every((y, j) => i === j || agree(x, y)))) { keep.push(...list); continue; }
    const score = (id: number) => {
      const priced = db.prepare(`SELECT 1 FROM platform_sku_map WHERE title_id=? AND sku_role='base'
        AND msrp_usd_cents IS NOT NULL LIMIT 1`).get(id) ? 1 : 0;
      const valued = (db.prepare(`SELECT COUNT(*) AS n FROM window_estimates_daily WHERE title_id=? AND platform=?
        AND window='ltd' AND units_mid IS NOT NULL`).get(id, platform) as { n: number }).n;
      return { id, priced, valued, req: id === requested ? 1 : 0 };
    };
    const best = list.map(score).sort((a, b) => b.priced - a.priced || b.valued - a.valued || b.req - a.req || a.id - b.id)[0];
    keep.push(best.id);
  }
  return keep;
}
