# PS5 Anchor-Collapse Fix — Cascade Suppression + Steam-Pace Monotonicity + RE Requiem Canonicalization

**Date:** 2026-09-11
**Author:** Claude (with Steve Allison approval to proceed)
**Scope:** `signalpulse/` only (isolated from SentimentPulse deploy per 2026-08-30 lesson)
**Supersedes:** `tasks/ps5-algo-fixes.md` (obsolete framing — real bug is cascade fallback, not bootstrap)

## Problem — verified from live DB (2026-09-12)

Screenshot evidence: RE Requiem: Deluxe Edition, Marvel Tokon, Reanimal, Halo: Campaign Evolved, Mortal Kombat 1, Marvel's Spider-Man 2, and ~34 other PS5 titles appear on the d7 leaderboard with an `EST. VIA <wider window>` badge — meaning the requested window's `units_mid` is null and the UI has fallen through the `d7 → d30 → d90 → m12 → ltd` COALESCE cascade in `routes-console-leaderboards.ts:252-258`.

**Live-DB verified anchor patterns (from probe run 34665952741):**

| Title | title_id | d7 | d30 | d90 | m12 | ltd | Root cause |
|---|---|---|---|---|---|---|---|
| RE Requiem: Deluxe | 10335, 10623 | ∅ | ∅ | ∅ | 100,080 | 100,080 | ltd-only, no shorter-window signal |
| Marvel Tokon | 10395 | ∅ | ∅ | 6,335 | 6,335 | 6,335 | bootstrap fires only at d90 |
| Halo: Campaign Evolved | 10334 | ∅ | ∅ | 9,012 | 9,012 | 9,012 | bootstrap fires only at d90 |
| MK1 | 10634 | 60,178 | 60,178 | 60,178 | 60,178 | 60,178 | steam-pace with degenerate ratio (Steam sibling 10195 has w7=w30=w90=910) |
| Spider-Man 2 | 10352, 10622 | 2,926 | 28,032 | 63,713 | 140,197 | 257,461 | monotonic! but 2 title_ids for same game |
| Reanimal | 10644 | ∅ | ∅ | ∅ | 17,143 | 17,143 | ltd-only, no steam sibling ratio |

## Verified truths (do not re-infer)

- The `method` column in `window_estimates_daily` reflects what wrote the ROW. `ltd-anchor-median-v03` is copied from the multiplier config; the estimator only overrides it with `backfill-bootstrap` or `backfill-steam-pace` for cascade rungs 3-4.
- Cascade is authoritative: `CASCADE_BY_WINDOW.d7 = ["d7","d30","d90","m12","ltd"]` (routes-console-leaderboards.ts:253). COALESCE picks the first non-null; `cascadeWindowUsed` records which window won so the client can badge `EST. VIA <w>`.
- PS5 has no native short-window signal (only LTD). Every PS5 window flows through backfill rungs 3-4.
- Forward-history depth as of 2026-09-11: ps5=2d. Forward-delta at line 500-507 requires `historyDays > winDays`, so on 2026-09-12 forward-delta cannot fire for any window ≥ 3d.

## Fix plan

### Fix 1 — Suppress short-window rows that fall back too far ("cascade cliff")

**File:** `signalpulse/server/routes-console-leaderboards.ts`

**Behavior change:** Introduce a max-cascade-distance rule. For a requested window `W`, only allow the cascade to fall through to the *next* wider window, not all the way to `ltd`. If a row has to reach ≥2 rungs deeper, exclude it from that window's leaderboard entirely. This means:

- `d7` request: accept d7 or d30. Reject rows whose earliest non-null is d90/m12/ltd.
- `d30` request: accept d30 or d90. Reject m12/ltd fallbacks.
- `d90` request: accept d90 or m12. Reject ltd fallback.
- `m12` and `ltd` unchanged.

**Rationale:** A one-rung fallback (d7 → d30, ~4x ratio) still gives operators a reasonable sense of near-term velocity — they see the badge and know it's approximate. A three-rung fallback (d7 → ltd, potentially 50x-100x) is actively misleading; the number displayed has no relationship to "last 7 days."

**Implementation:** Add a WHERE filter after the LEFT JOIN chain that requires the winning cascade rung to be `<= 1` steps deeper than requested. Simplest form: `WHERE w0.units_mid IS NOT NULL OR w1.units_mid IS NOT NULL` when the requested window has ≥2 cascade rungs.

**Acceptance:**
- Post-deploy `/api/leaderboards/console?platform=ps5&window=d7` no longer shows any row with `est_via` of `d90`, `m12`, or `ltd`.
- Post-deploy `/api/leaderboards/console?platform=ps5&window=d30` no longer shows any row with `est_via` of `m12` or `ltd`.
- RE Requiem Deluxe (100K units) and Reanimal (17K) drop off the d7 board because their earliest non-null is m12.
- Marvel Tokon and Halo: Campaign Evolved stay on the d90 board (badged `EST. VIA D90`) since they have real d90 data, but drop off d7 and d30.
- Onimusha, Spider-Man 2, Dispatch Ep1, ARC Raiders, 007 First Light — all keep their d7 rows because they have real d7 numbers.

### Fix 2 — Steam-pace monotonicity guard

**File:** `signalpulse/scripts/estimate-console-units.ts` around lines 365-390 (helpers) and 518-523 (caller).

**Behavior change:** Add `steamWindowRatiosMonotonic(titleId)` that returns `{d7, d30, d90, m12}` with `d7 ≤ d30 ≤ d90 ≤ m12`. Apply running-max from short → long. Existing `steamWindowRatio` becomes a thin wrapper that reads from this record.

**Why this alone doesn't fix MK1:** MK1's Steam sibling (10195) has degenerate ratios (all equal because its Steam presence is flat). Monotonicity holds trivially (all equal is a valid monotonic sequence). Fix 1 catches this: MK1's d7=d30=d90=m12=ltd means every rung of the cascade returns the same value, so `cascadeWindowUsed` will report `d7` (the first rung) and MK1 stays on the d7 board with a badly-flat but honestly-labeled number. That's the right outcome — the underlying data really is flat, and Fix 1 preserves the row when the earliest rung has data.

**Purpose of Fix 2:** correctness invariant for the broader estimator. Prevents future titles where Steam's window ratios come out non-monotonic (measurement noise on medium-sized Steam siblings) from producing inverted console signals like d30 > d90.

**Acceptance:**
- Unit-testable: `steamWindowRatiosMonotonic(mockId)` returns `null` when ltd < 100, and `{d7, d30, d90, m12}` with `d7 ≤ d30 ≤ d90 ≤ m12` otherwise.
- Post-deploy re-estimator run: no PS5 title has d7 > d30, d30 > d90, or d90 > m12 in `window_estimates_daily`.

### Fix 3 — Delete duplicate PS5 title_ids for RE Requiem: Deluxe Edition (10335 vs 10623)

**Verified:** Both title_ids show identical PS5 signal (100,080 rating count, same m12/ltd, identical `store_rating_signal_daily` history). This is the same SKU indexed twice.

**Action:** Keep 10335 (older, has `store_release_date`), delete 10623 via `signalpulse-db-admin.yml`. Also delete any `window_estimates_daily` rows for 10623.

**Acceptance:**
- `SELECT COUNT(*) FROM console_title_igdb WHERE title_id=10623` returns 0.
- `SELECT COUNT(*) FROM window_estimates_daily WHERE title_id=10623` returns 0.
- The leaderboard shows RE Requiem: Deluxe exactly once (via 10335).

### Fix 4 — Delete duplicate PS5 title_ids for Marvel's Spider-Man 2 (10352 vs 10622)

**Verified:** Both title_ids have identical PS5 window_estimates (d7=2926, d30=28032, d90=63713, m12=140197, ltd=257461). Same game, indexed twice.

**Action:** Keep 10352, delete 10622 via `signalpulse-db-admin.yml`.

**Acceptance:**
- `SELECT COUNT(*) FROM console_title_igdb WHERE title_id=10622` returns 0.
- Spider-Man 2 shows exactly once on the leaderboard.

### Fix 5 — Delete duplicate PS5 title_ids for Dying Light: The Beast (10386 vs 10652)

**Verified:** Identical window_estimates for both. Same SKU indexed twice.

**Action:** Keep 10386, delete 10652.

### Fix 6 — Add RE Requiem BASE SKU as the canonical PS5 row and roll Deluxe under it

**Problem:** The PS5 store lists both `Resident Evil Requiem` (base, PS Store product id `EP0102-PPSA02826_00-DUMMYRERQMPS500`) and `Resident Evil Requiem: Deluxe Edition` (upgrade SKU). Only the Deluxe SKU is currently in our `console_title_igdb` with PS5 data. The base game — the primary consumer entry point — is missing. Xbox's handling (per Push 2 Wave A) folds Deluxe/Premium editions under the base game display name and sums their ratings.

**Action (research + bridge, matches Xbox pattern):**
1. Web-search the PS Store to identify the base PS5 SKU URL + name.
2. Confirm IGDB has a base "Resident Evil Requiem" entry.
3. Add a MANUAL_BRIDGE entry in `signalpulse/scripts/estimate-console-units.ts` linking PS5 rating signals for the base game to the correct title_id.
4. Add a display-name normalizer in `routes-console-leaderboards.ts` that maps "Deluxe Edition" / "Premium Edition" variants to the base game display name (like the Xbox path — check for existing code to reuse).
5. Kick estimator; verify base game surfaces on PS5 leaderboard with combined signal.

**Acceptance:**
- Base "Resident Evil Requiem" appears on the PS5 leaderboard with a non-null signal.
- Deluxe Edition either disappears from the leaderboard OR shows as a "+1 EDITION" badge attached to the base row (matching Xbox's UI behavior — check what Xbox currently renders).
- Combined rating count > current Deluxe-only 100,080.

## Sequencing

1. Write this plan (done).
2. Implement Fix 1 (cascade cliff) in `routes-console-leaderboards.ts`.
3. Implement Fix 2 (monotonicity) in `estimate-console-units.ts`.
4. Both changes in one commit. `confirm_action` before push.
5. Post-deploy: trigger estimator via `signalpulse-estimator.yml`, wait for completion.
6. Live-probe `/api/leaderboards/console?platform=ps5&window=d7` and verify RE Requiem Deluxe, Reanimal, Marvel Tokon dropped; verify no `est_via=ltd` badges on d7.
7. Execute Fixes 3, 4, 5 (SQL deletes) via `signalpulse-db-admin.yml`.
8. Research + execute Fix 6 (RE Requiem base SKU).

## Rollback

- Fix 1: revert the WHERE filter in `routes-console-leaderboards.ts` and redeploy signalpulse.
- Fix 2: revert the estimator commit; the monotonic helper is additive so removing it restores prior per-window behavior on the next estimator run.
- Fixes 3-5: rows can be re-inserted from prior IGDB matcher runs; no forward-history loss since duplicate title_ids' history was redundant.
- Fix 6: revert MANUAL_BRIDGE addition and display-name normalizer.
