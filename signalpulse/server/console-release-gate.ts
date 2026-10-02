// Release gating for the console/Steam buying leaderboards (pure helpers, no database access).

/**
 * SQL predicate that hides titles whose release date is still in the future. It exists because a console
 * pre-order window accumulates store-rating signal before any sale (COD Modern Warfare 4 appeared at
 * $1.82B on 2026-09-13). Rows with an unknown release date are kept.
 *
 * Steam rows are exempt (2026-10-02): a Steam estimate comes from reviews, and a review can only be written
 * by a buyer, so a future official date with a real Steam estimate means paid early access or early unlock
 * (Gears of War: E-Day Premium Edition, early access from 2026-10-01, launch 2026-10-06). Pass the SQL
 * expression for the platform column, or null when the query is already restricted to one platform.
 */
export function unreleasedGateSql(platformExpr: string | null, platform?: string): string {
  const released = `(
          (igdb.release_date IS NULL AND igdb.store_release_date IS NULL)
          OR date(
               CASE
                 WHEN (igdb.match_confidence = 'low' OR console_identity_matches(igdb.store_name, igdb.name) = 0)
                   THEN COALESCE(igdb.store_release_date, igdb.release_date)
                 ELSE COALESCE(igdb.release_date, igdb.store_release_date)
               END
             ) <= date('now')
        )`;
  if (platformExpr === null) return platform === "steam" ? "AND 1=1" : `AND ${released}`;
  return `AND (${platformExpr} = 'steam' OR ${released})`;
}

/**
 * Console revenue must not be derived from a Steam row whose official release is still in the future:
 * its estimate is a paid early-access sample, not the platform's launch. The console row keeps its own
 * native estimate until the Steam release date arrives. todayIso is YYYY-MM-DD.
 */
export function steamDerivationBlockedByFutureRelease(steamReleaseDate: string | null | undefined, todayIso: string): boolean {
  if (!steamReleaseDate) return false;
  const d = String(steamReleaseDate).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d > todayIso;
}
