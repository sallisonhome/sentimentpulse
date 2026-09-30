# Daily revenue gap and launch allocation

The PDP "Estimated daily revenue" chart differences the published lifetime (LTD)
unit estimate day over day. Two general situations used to leave days empty or
booked on the wrong day:

1. Gap: a calendar day has no LTD row. On 2026-09-24 the legacy refresh failed
   before estimates were written, so every platform-title (1,142 series) has no
   September 24 row while ratings snapshots and Steam daily review buckets for
   that day exist. Differencing across the gap either booked two days on
   September 25 or, after #160, left both days empty.
2. Launch: the first published LTD value carries everything sold since release
   and has no predecessor (Control Resonant on Steam, PS5 and Xbox showed nothing
   before September 26).

## Contract

`server/daily-gap-allocation.ts` is read-only and holds no title identity. It
splits an authoritative LTD change across the days it happened. It never changes a
lifetime, window or leaderboard total and writes nothing.

- Protected titles are never touched. A sibling group with any revenue
  calibration anchor (actual or publicly reported), manual multiplier override,
  active public unit milestone, or a Saber product with Steamworks sales keeps
  the strict behavior. An unexpected check failure also protects.
- Only titles with a missing day change. Every day that already has a value is
  identical before and after.
- Gap: consecutive published LTD values more than one day apart (up to 7 days)
  have their non-negative change split across the missing days, but only when
  the platform's own signal growth explains the change (no re-basing jumps, no
  method flips, no negative changes). One row per date per platform is required.
- Launch: the first published LTD value is split across the days since a zero
  baseline (up to 14 days), and only when a release date corroborates a launch
  (from 7 days before to 14 days after the first published value). The baseline
  is the latest earlier row recording zero signal, otherwise the day before
  release. A launch needs the platform's own dated evidence: never a borrowed
  shape, never an even split.
- Rebased gap: when LTD units fell across the gap because the estimator's units-per-review
  ratio was reset (Steam multiplier reset, 2026-09-24/25), the published change is a re-scale,
  not sales. The gap days are the review growth valued at the post-reset ratio, the same way
  every adjacent day after the reset is valued. Requires the same estimator method on both
  sides, review growth, and confirmation of the ratio (within 2%) by the next adjacent
  published pair; otherwise nothing is allocated. Labelled `rebased_gap:<basis>`. Days before the
  reset keep their old scale; they are not restated.
- Weights, first available:
  - Steam launch: next-day review activity. Saber's own Steamworks actuals for
    Twisted Tower (launch 2026-08-18) show reviews trail purchases: same-day
    review shares misallocate 21 to 34 percent of units across days, next-day
    shares 3 to 9 percent. This is one launch, so it is a validated starting
    point, not a universal constant (`REVIEW_LAG_DAYS`).
  - Steam otherwise: same-day review activity (the last day is the remainder of
    the snapshot count), then the title's own rating snapshots.
  - PS5 and Xbox: the platform's own rating growth on those days. For a gap
    between two real observations only, the Steam sibling's dated activity shape
    (modeled) when the console has no evidence for the missing day.
  - Otherwise nothing is allocated. Missing days stay empty rather than being
    split evenly or zero-filled.
- The existing outlier guards still apply to gap spans, and the daily mix ledger
  still overrides recorded days.
- Duplicate same-platform sibling rows disable allocation from the first
  ambiguous date onward, not for the preceding unique history. Extending the
  requested end date must not erase earlier valid launch/gap allocations merely
  because a later duplicate row entered the response window. This is a read-time
  scope correction; it does not deduplicate ambiguous rows or alter LTD totals,
  calibration anchors, manual overrides, milestones, or Saber actuals.
- For eligible, unprotected groups only, a null sibling estimate is ignored
  when a valued estimate exists on that platform/date. It cannot overwrite a
  valid daily point. Two valued sibling rows are still treated as ambiguous,
  not summed or arbitrarily selected. Protected groups and the kill switch
  retain their original behavior byte-for-byte.
- Each allocated point carries `allocation: {platform: "gap|launch:<basis>"}` and
  the methodology text says allocated days are modeled.

## Reversibility

Set env `DAILY_GAP_ALLOCATION_ENABLED=0` or app setting
`daily_gap_allocation_enabled=0` to return to the strict behavior (nonadjacent
days empty).

## Root cause of the missing September 24 estimates

`SignalPulse - Daily Console Leaderboards Refresh` (scheduled, run 36011069078)
failed in "Run discovery + collectors" on 2026-09-24; its PS5 collector had no
September 24 snapshots (21 of 310 titles) and the estimator step did not run.
The guarded systemd timer added on 2026-09-25 (#140) replaced that path. The
read-time allocation makes any future missed run degrade to a modeled, labeled
split instead of an empty or double-booked day.
