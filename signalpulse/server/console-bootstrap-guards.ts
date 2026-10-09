// Operator-scoped lifetime-bootstrap guards (2026-10-09).
//
// The backfill-bootstrap premise — "title released inside the window → its
// LTD rating count IS the windowed signal" — is only truthful when the
// rating pool actually accrued inside the window. A newly discovered listing
// can inherit its concept's years-old rating pool on day one (PSN concept
// ratings are shared across a concept's SKUs), and the bootstrap then
// presents the concept's lifetime pool as launch-window sales (d7 = d30 =
// LTD on the boards).
//
// These guards disable ONLY the bootstrap step for the listed
// (title_id, platform) pairs. Their listing dates are genuine launch dates of
// the new versions and are preserved; the LTD path, forward-delta,
// observed-pace, steam-pace and every other title are untouched.

export type ConsoleBootstrapGuard = {
  titleId: number;
  platform: "ps5" | "xbox";
  reason: string;
};

export const CONSOLE_BOOTSTRAP_GUARDS: readonly ConsoleBootstrapGuard[] = [
  {
    // Mafia III: Definitive Edition — native PS5 version released 2026-10-08
    // (10-year-anniversary 60fps update; free upgrade for existing owners).
    // The new listing inherits the DE concept's pool: 63,690 ratings accrued
    // since the DE's original 2020-05-19 launch. The pool is not
    // launch-window sales of the PS5 version.
    titleId: 11389,
    platform: "ps5",
    reason: "new PS5 version (2026-10-08) inherits the DE concept's 63,690-rating pool (live since 2020-05-19)",
  },
  {
    // Dragon's Dogma 2: Dark Arisen — new edition released 2026-10-09
    // (expanded re-release of the 2024-03-22 game; PSN GAME_BUNDLE). The new
    // listing inherits the DD2 concept's pool: 45,750 ratings accrued since
    // 2024-03-22. The pool is not launch-window sales of the edition.
    titleId: 11352,
    platform: "ps5",
    reason: "new edition (2026-10-09) inherits the DD2 concept's 45,750-rating pool (live since 2024-03-22)",
  },
];

const guardKeys = new Set(CONSOLE_BOOTSTRAP_GUARDS.map((g) => `${g.titleId}|${g.platform}`));

/** True when the (title, platform) pair must not use the lifetime-bootstrap path. */
export function isBootstrapIneligible(titleId: number, platform: string): boolean {
  return guardKeys.has(`${titleId}|${platform}`);
}
