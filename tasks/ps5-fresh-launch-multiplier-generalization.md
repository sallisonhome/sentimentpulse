# PS5 Fresh-Launch Multiplier Generalization — Finding & Recommendation (Not Implemented)

**Date:** 2026-09-19
**Author:** Claude (with Steve Allison approval to document; NOT approved to implement)
**Scope:** `signalpulse/` PS5 unit-estimation methodology — documentation only, no code change in this write-up
**Trigger:** Marvel's Wolverine (PS5) per-title override (`title_id=10302`, see
`signalpulse/scripts/seed-title-multiplier-override-2026-09-19-wolverine.ts`)

## Finding

The PS5 platform-wide default multiplier (24x, `ownership_multipliers` id=9,
`effective_from=2026-09-11`) was fitted (`method=ltd-anchor-median-v03`) from
LTD anchors on titles that had, at fit time, been out for months: Ghost of
Yōtei (3.3M), Baldur's Gate 3 PS5 (~5M), Helldivers 2 PS5-majority (20M).
Each of those anchors reflects a *mature* rating-to-owner ratio — the
population of buyers who will ever leave a rating has had months to do so.

Marvel's Wolverine launched 2026-09-15 and is a heavily pre-order-weighted
blockbuster. A public analyst estimate (Alinea Analytics, published
2026-09-18) put Wolverine at 1.9M units sold in its first 3 days, ~1M of
which were pre-launch digital pre-orders converting at midnight launch
(https://alineaanalytics.substack.com/p/wolverine-sells-19m-despite-the-online).
Pairing that 1.9M anchor against the ACTUAL day-3 cumulative rating signal
(`store_rating_signal_daily`, 2026-09-17, rating_count=25,027) implies a
multiplier of **57.7x** — more than double the 24x platform default.

**Interpretation:** this is not evidence that Wolverine specifically is an
outlier scored wrong by the platform default. It is evidence that a
freshly-launched, pre-order-heavy title's *early-window* rating conversion is
transiently much thinner than a mature title's, because a large pre-order
cohort has bought the game but has not yet had time to play enough of it to
leave a rating. The 24x default is correctly calibrated for mature titles and
is **structurally likely to under-estimate any newly-launched PS5-exclusive
title's true units during its first days-to-weeks window** — this is a
generalizable pattern, not a Wolverine-only anomaly.

## Why this can't be auto-corrected today

`signalpulse/scripts/refit-ownership-multipliers.ts` (301 lines) is the only
automated multiplier-fitting mechanism in the codebase, and it is explicitly
**Steam-only** today:

> "Only 'steam' platform for now (no PSN/MS actuals in DB yet)"

There is no automated PS5 (or Xbox) refit path. The only lever available for
a PS5 title whose estimate is known to be wrong is a manual per-title row in
`title_multiplier_overrides` — exactly the mechanism used here, and the same
pattern already established for Wardogs on Steam
(`signalpulse/scripts/seed-title-multiplier-overrides-2026-09-13.ts`).

## Forward-projection limitation of the override mechanism itself

`estimate-console-units.ts`'s override-selection logic picks the override row
with the latest `effective_from <= today` and applies its multiplier flatly
to *whatever the current day's cumulative signal is*, every day, going
forward — it is not re-anchored to the original 3-day snapshot. Combined with
the LTD accumulator's "override anchors are a floor, not a ceiling" resolver
(commit `7a4b54e`, 2026-09-15), this means Wolverine's LTD will keep growing
day-over-day at the fixed 57.7x rate applied to new rating-count deltas, even
though those deltas partly reflect pre-order-backlog rating catch-up rather
than 100% new sales. This is a known, accepted limitation of today's
mechanism — flagged in the override row's own `notes` field — not something
this generalization finding proposes to fix.

## Recommendation (documented only — not approved for implementation)

Two non-exclusive paths forward, in increasing order of engineering cost:

1. **Age-based / day-1-weighted decay adjustment.** Build a time-varying
   multiplier curve for freshly-launched titles (first N days post-release)
   that starts higher (approximating the thin early-rating-conversion regime)
   and decays toward the mature platform default as the title ages and its
   rating pool catches up. Requires deciding N, the decay shape, and how it
   composes with per-title overrides.
2. **Accumulate more early-window PS5 anchors.** Wolverine is currently the
   only PS5-exclusive title with a *day-3* public sales anchor in this
   dataset. Before building new algorithm infrastructure, it would be safer
   to test whether 57.7x-vs-24x is a one-off or a repeatable pattern by
   capturing the same day-3 (or day-7) analyst/publisher anchor for the next
   1-2 PS5-exclusive AAA launches and checking whether their implied
   early-window multipliers cluster meaningfully above 24x too.

Recommend path 2 first — it's zero-code and directly tests whether the
generalization holds before committing to path 1's added complexity. Neither
path is approved for implementation as of this write-up; this document exists
solely to record the finding for future reference per explicit user request.

## Sources

- https://alineaanalytics.substack.com/p/wolverine-sells-19m-despite-the-online
- https://www.ign.com/articles/marvels-wolverine-has-sold-well-early-data-suggests-but-dont-expect-spider-man-numbers
- https://www.eurogamer.net/marvel-wolverine-sales-ps5-physical-controversial-reviews
- https://www.gamesradar.com/games/action/marvels-wolverine-beat-death-stranding-2s-entire-lifetime-ps5-revenue-in-3-days-even-with-everyone-making-fun-of-it-analyst-estimates-with-1-9m-copies-sold/
- https://www.playstationlifestyle.net/2026/09/18/marvel-wolverine-ps5-sales-record-criticism/
