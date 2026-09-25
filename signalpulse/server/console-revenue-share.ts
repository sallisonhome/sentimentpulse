/** Presentation aggregates only: never changes the estimator or allocations. */
export const SHARE_PLATFORMS = ["steam", "ps5", "xbox"] as const;
type BoardRow = { revenueSteam: number | null; revenuePs5: number | null; revenueXbox: number | null };
export function revenueSummary(rows: BoardRow[], window: string) {
  const fields = { steam: "revenueSteam", ps5: "revenuePs5", xbox: "revenueXbox" } as const;
  const totals = SHARE_PLATFORMS.map(platform => ({
    platform, revenueUsd: rows.reduce((sum, row) => sum + (row[fields[platform]] ?? 0), 0),
    missingTitleCount: rows.filter(row => row[fields[platform]] == null).length,
  }));
  const incomplete = totals.some(row => row.missingTitleCount > 0);
  const combinedRevenueUsd = totals.reduce((sum, row) => sum + row.revenueUsd, 0);
  return {
    window, titleCount: rows.length, combinedRevenueUsd, incomplete,
    platforms: totals.map(row => ({
      ...row, sharePct: !incomplete && combinedRevenueUsd > 0 ? row.revenueUsd / combinedRevenueUsd * 100 : null,
    })),
  };
}
