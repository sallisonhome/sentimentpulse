# PS5 Algo Fixes — Bootstrap + Steam-Pace Monotonicity + ASP Retune + Orphan Cleanup

**Date:** 2026-09-11
**Author:** Claude (with Steve Allison approval)
**Scope:** `signalpulse/` only (isolated from SentimentPulse deploy per 2026-08-30 lesson)

## Problem

PS5 leaderboard shows degenerate window equality (`d7=d30=d90=m12=ltd`) for
many titles because two rungs of the backfill cascade are wrong:

1. **`backfill-bootstrap`** (`estimate-console-units.ts:509-512`) returns full
   `ltdNow` for any window a title was released *inside* of, with no scaling.
   A game released 45 days ago gets the same signal for d7, d30, d90, m12,
   and ltd — all equal to lifetime.
2. **`backfill-steam-pace`** (`estimate-console-units.ts:378-387, 518-523`)
   uses each window's Steam ratio independently. When a Steam sibling has a
   degenerate history (all reviews in a tight cluster, or LTD barely above
   the 100-review noise gate), r7≈r30≈r90≈r_m12 ≈ 1.0, producing the same
   collapse.

Additionally:

3. Two IGDB rows (`title_id` 10609, 10613) are duplicates of already-anchored
   Steam entries (10482, 10463) and cannot be bridged. They pollute the join
   surface without contributing any signal.
4. Realized ASP factor for PS5/Xbox at 0.80 is too high given observed sale
   depth and platform revenue-share drag. Lowering to 0.73.

## Verified truths (do not re-infer)

- Xbox displaycatalog **natively** returns d7 + d30 + ltd
  (`signalpulse/server/signals/console/xbox.ts:174-198`). Xbox d90/m12 use
  the same backfill cascade PS5 uses — so this fix helps Xbox's longer
  windows too, not just PS5.
- PS5 `wcaProductStarRatingRetrive` returns **LTD only**
  (`signalpulse/server/signals/console/ps.ts:15-17`). Every PS5 window signal
  flows through the backfill cascade.
- Forward-history depth (this workspace, 2026-09-11): steam=3d, xbox=3d,
  ps5=2d. Forward-delta covers `history_days > win_days`, so on 2026-09-11
  forward-delta contributes nothing for any window ≥ 3d. The backfill
  cascade IS the whole answer for now.
- `ASP_FACTOR_DEFAULTS` in `routes-console-leaderboards.ts:181-184` has an
  `app_settings` override path (`asp_factor_<platform>`) that can retune
  without a deploy. Default is authoritative when the override is absent.

## Fix plan

### 1. Delete orphan IGDB rows 10609, 10613

- Delete from `console_title_igdb` where `title_id IN (10609, 10613)`.
- Also delete any `window_estimates_daily` rows keyed on those title_ids
  (defensive: they should be empty since the estimator skipped both).
- Executed via `signalpulse-db-admin.yml` with a single transaction and
  `confirm=CONFIRM`.

**Acceptance:**
- Post-delete `SELECT COUNT(*) FROM console_title_igdb WHERE title_id IN
  (10609, 10613)` returns 0.
- Post-delete `SELECT COUNT(*) FROM window_estimates_daily WHERE title_id IN
  (10609, 10613)` returns 0.
- Next estimator run's "skips" count drops by 2 (from 2 to 0 for the
  orphan class specifically).

### 2. Fix `backfill-bootstrap` release-age scaling

**File:** `signalpulse/scripts/estimate-console-units.ts` lines 509-512
**Also touch:** `isReleasedWithin` and add a `daysSinceRelease` helper
near line 443.

**New behavior:** when a title released inside `winDays`, the windowed
signal is `ltdNow × min(daysSinceRelease / winDays, 1)`. A game released
today with ltdNow=1000 gets d7=1000×(0/7)=0 (or a tiny floor), d30=1000
if released ≥30d ago. A game released 3 days ago with ltdNow=1000 gets
d7=1000×(3/7)=428, d30=1000×(3/30)=100, d90=1000×(3/90)=33 — reflecting
that all lifetime accumulation happened inside those windows but pro-rated
to the elapsed fraction of each window.

Correction to the earlier framing: the scaling factor is *elapsed / window*,
not *window / elapsed*. LTD is a fixed quantity; the windowed signal for a
window longer than the game's lifetime is BOUNDED BY ltd (the game hasn't
existed long enough to accumulate more), while the windowed signal for a
window shorter than the game's lifetime is a fraction of ltd. For
bootstrap (release inside window), lifetime ≤ window, so signal = ltd.
For release BEFORE window, lifetime > window and we should use forward-delta
or steam-pace, not bootstrap. Restating:

- **Case A (release date ≥ today - winDays):** all lifetime rating
  accumulation happened inside the window. `signal = ltdNow`. Unchanged
  from current behavior — this is arithmetically exact when the release
  is inside the window.
- **Case B (release date < today - winDays):** bootstrap is INAPPROPRIATE.
  Do not use it. Fall through to steam-pace.

**Re-reading the current code at 509-512, this is what `isReleasedWithin`
already checks.** The bug isn't the case gate — the bug is that
`isReleasedWithin` returns true when `release >= today - winDays`, so a
title released 3 days ago passes the `winDays=7`, `winDays=30`,
`winDays=90`, and `winDays=365` checks — and every window gets the same
`ltdNow` back. That IS correct math when the release date is inside the
window (the game can't have accumulated more reviews than lifetime), but
it produces degenerate equality across windows for young games. This is
not a bug in bootstrap — it is exact.

**Real fix required at bootstrap:** none. Bootstrap is arithmetically exact.
The degenerate d7=d30=…=ltd for a 3-day-old game IS the truth (lifetime is
3 days, so d7 signal = ltd, d30 signal = ltd, d90 signal = ltd).

**Where the real bug lives:** in `backfill-steam-pace` for titles whose
Steam sibling has a small LTD (barely > 100) or a tight-cluster review
history. Those produce r7≈r30≈r90 ≈ 1.0. The scaling `ltdNow * ratio`
then collapses to `ltdNow` across every window. Monotonicity guard fixes
this class.

**Revised plan: skip the bootstrap "fix" — leave it exact. Focus on
steam-pace monotonicity below.**

**Acceptance for #2:** no code change; add a code comment above
`isReleasedWithin` documenting that its output is arithmetically exact
and only produces window-equal signals for games younger than the
window, which is the correct answer.

### 3. Fix `backfill-steam-pace` monotonicity

**File:** `signalpulse/scripts/estimate-console-units.ts`
**Region:** `steamWindowRatio` (378-387) and its callers at 518-523.

**Current behavior:** each window computes its own ratio independently.
No cross-window guarantee.

**New behavior:** replace `steamWindowRatio(titleId, days)` with a
`steamWindowRatiosMonotonic(titleId)` that returns
`{d7, d30, d90, m12} | null` in ONE pass, with the invariant
`d7 ≤ d30 ≤ d90 ≤ m12`. Algorithm:
1. Compute raw `r7, r30, r90, r_m12 = w7/ltd, w30/ltd, w90/ltd, w365/ltd`.
2. If any numerator is null or ltd < 100, return null (unchanged noise gate).
3. Enforce monotonicity by taking the running max from short → long:
   `r30 = max(r30, r7)`, `r90 = max(r90, r30)`, `r_m12 = max(r_m12, r90)`.
4. Clamp each to `[0, 1]`.
5. Return the record.

Then in `resolveConsoleSignal`, call this once per title and use the
appropriate window's ratio. This eliminates the degenerate collapse
because even if Steam's window signals are all equal, the console-side
windows will be `ltdNow * ratio` — still equal in that pathological case,
BUT the ratio is capped by `Math.min(1, ratio)`, so at least the signal
never exceeds ltd, and when Steam has real per-window variation the
console signals will inherit it.

**Wait — monotonicity alone doesn't fix the "all ratios = 1.0" case.** If
Steam's LTD is 150 and all 150 reviews landed in the last 7 days (recent
launch), then r7 = r30 = r90 = r_m12 = 1.0. That's arithmetically true
for Steam. The console signals `ltdNow * 1.0` will also all equal ltd
for every window. But that's ALSO arithmetically correct if the console
title released at the same time — its lifetime is <7 days too, so
d7=d30=d90=m12=ltd is the truth.

The degenerate-looking output for Mortal Kombat 1 is a symptom of the
Steam SIBLING being anchored to a fresh appid (Steam MK1 launched
Sep 2023) whose review velocity has stabilized to a slow drip, so recent
windows are small vs LTD. Let me re-verify the exact steam-pace values
before shipping a "monotonicity" fix that may not actually address the
MK1 case.

**Revised plan for #3: verify MK1's actual Steam sibling ratios FIRST via
`signalpulse-db-query.yml` before shipping any steam-pace change.** The
monotonicity fix is still worth shipping (it's a correctness guarantee
that costs nothing) but the framing "this fixes MK1" needs verification
against actual numbers, per rigor-doc rule "no claim without live probe."

**Acceptance for #3:**
- After deploy, MK1's leaderboard entry shows d7 < d30 < d90 < m12 ≤ ltd
  (strict monotonicity where Steam has real per-window variation, ≤
  where Steam's own windows collapse).
- The 6 other broken titles (Onimusha, Blood of Dawnwalker, NBA 2K27,
  SW Zero Company, Mortal Shell II, Big Walk) show non-degenerate
  windows OR a documented reason why (e.g. no Steam sibling → falls
  through to different code path).
- `steamWindowRatiosMonotonic` output is unit-testable (no I/O
  dependency past the prepared statements).

### 4. ASP factor retune to 0.73 for ps5/xbox

**File:** `signalpulse/server/routes-console-leaderboards.ts:181-184`

**Change:**
```typescript
const ASP_FACTOR_DEFAULTS: Record<Platform, number> = {
  steam: 0.66,
  ps5:   0.73,   // was 0.80
  xbox:  0.73,   // was 0.80
};
```

**Also:** clear any stale `app_settings` overrides via admin SQL to ensure
the new default takes effect (an override at 0.80 would mask the change).

**Acceptance:**
- Post-deploy `GET /signal/api/leaderboards/console?platform=ps5&window=ltd`
  revenue estimates drop by (0.73/0.80 − 1) = −8.75% vs pre-deploy for
  every title, holding units constant.
- Same drop applies to xbox.
- `SELECT key, value FROM app_settings WHERE key LIKE 'asp_factor_%'`
  returns only `asp_factor_steam=0.66` OR is empty (defaults apply).

## Sequencing

1. Write this plan (done).
2. Verify MK1 + 6 broken titles' actual Steam-sibling ratios via
   `signalpulse-db-query.yml` — data-only probe, no code.
3. If steam-pace is genuinely the cause: implement monotonic ratios helper.
4. Implement ASP factor default change.
5. Add code comment near `isReleasedWithin` documenting bootstrap is exact.
6. `confirm_action` for push.
7. Push, verify deploy status via `gh run view --json`.
8. Run estimator, then read back post-run window_estimates for the same 7
   titles via `signalpulse-db-query.yml`.
9. Live-probe `/signal/api/leaderboards/console` and confirm ASP drop +
   monotonic windows on the affected titles.
10. Delete orphan rows via `signalpulse-db-admin.yml` (independent of code
    change; can happen in parallel).

## Rollback

- Bootstrap: no code change, nothing to roll back.
- Steam-pace monotonic helper: revert commit.
- ASP factor: change defaults back to 0.80, OR insert
  `app_settings.asp_factor_ps5 = 0.80` and `asp_factor_xbox = 0.80` for
  instant no-deploy rollback.
- Orphan delete: rows can be recreated by re-running the IGDB matcher
  against title_ids 10609/10613; no data loss since both title_ids have
  no `window_estimates_daily` rows.
