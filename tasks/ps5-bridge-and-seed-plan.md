# PS5 MANUAL_BRIDGE + Steam anchor seed — plan & acceptance

**Date:** 2026-09-11
**Reason:** PS5 top-100 rows 7–100 render with only #ratings (no revenue/units)
in d7/d30/d90/m12 views. Root cause per `routes-console-leaderboards.ts` gate:
`preLtdHasSignal=false` for those rows → revenue/units gated to NULL. Fix path:
fill d7/d30/d90/m12 units by bridging PS5 titles to Steam anchors so
`backfill-steam-pace` can compute per-window curves.

## Acceptance criteria (write BEFORE code, per CLAUDE.md §23)

1. **Live Steam Store API probe** returns HTTP 200 + a matching `name` for
   every new Steam anchor appid I'm about to seed. Any 404 or name mismatch
   → drop that anchor from the seed set.
2. **Seed writes succeed:** after admin workflow runs, a follow-up read
   probe confirms N rows added to `platform_sku_map` where platform='steam'
   AND title_id in the new seed range, each with sku_role='base',
   business_model='paid', non-NULL msrp.
3. **Bridge additions compile:** `npm run build` clean; `tsc --noEmit`
   clean.
4. **Estimator rebuild:** trigger `signalpulse-estimate-console-units`
   workflow. Its log must show `manual=<N>` where N ≥ 16, and
   `bridgedManualEntries` matches. No "manual bridge skipped" WARN lines.
5. **Post-run DB check:** for each PS5 title in the bridge set,
   `window_estimates_daily` now has rows with `platform='ps5' AND window IN
   ('d7','d30','d90','m12') AND units_mid IS NOT NULL`. Ground-truth
   count of ps5 titles with d30 signal must rise by ≥ 12 vs. baseline (47).
6. **UI render check:** hit `/api/console/leaderboards?platform=ps5&window=d30`
   live; response rows for the bridged title_ids must have non-null
   `revenue` and `unitsMid`, `gatedReason !== 'ltd_only_signal'`.

Rollback: revert the two commits (seed + bridge). Steam side seed rows can be
manually deleted via admin workflow if a name/appid mismatch is discovered
after deploy.

## Seed set (11 new Steam anchors)

Assigned title_ids continue 10604-10614 range (10600-10603 used previously).

| new_tid | Steam appid | Title (canonical) | msrp_cents |
|---|---|---|---|
| 10604 | 1774580 | STAR WARS Jedi: Survivor | (probe) |
| 10605 | 292030  | The Witcher 3: Wild Hunt | (probe) |
| 10606 | 359550  | Tom Clancy's Rainbow Six Siege | (probe) |
| 10607 | 2001120 | Split Fiction | (probe) |
| 10608 | 1167630 | Teardown | (probe) |
| 10609 | 1172620 | Sea of Thieves | (probe) |
| 10610 | 752590  | A Plague Tale: Innocence | (probe) |
| 10611 | 2523770 | LOTR: War in the North Legacy Edition | 1999 (probed) |
| 10612 | 2131630 | MGS Master Collection Version | 1999 (probed) |
| 10613 | 2358720 | Black Myth: Wukong | 5999 (probed) |
| 10614 | 3008130 | Dying Light: The Beast | 5999 (probed) |

**Probe results:** All 10 confirmed live via `store.steampowered.com/api/appdetails`. Corrections vs. draft: 209580 delisted → replaced with 2523770 (Legacy Edition remaster, valid). 3116460 was wrong game ("ROOM 24/7 Surveillance") → replaced with correct Dying Light Beast appid 3008130. R6 Siege dropped (base is F2P, no matching paid base SKU on Steam to anchor the Elite Edition monetization SKU).

## MANUAL_BRIDGE additions (16 rows)

Same shape as Xbox rows already in `estimate-console-units.ts:229`.

| ps5_tid | steam_tid | notes |
|---|---|---|
| 10321 | 10103 | AC Black Flag Resynced ↔ Steam AC BF Resynced |
| 10312 | 10455 | CoD MW4 Vault ↔ CoD Modern Warfare 4 |
| 10396 | 10082 | Skyrim AE PS5/PS4 ↔ Skyrim SE |
| 10377 | 10016 | Rust Console ↔ Rust |
| 10356 | 9002  | RE4 Gold PS4/PS5 ↔ RE4+CV bundle |
| 10358 | 10604 | Jedi Survivor PS5 ↔ new Steam anchor |
| 10373 | 10605 | Witcher 3 Complete PS5 ↔ new Steam anchor |
| 10329 | 10607 | Split Fiction PS5 ↔ new Steam anchor |
| 10378 | 10608 | Teardown PS5 ↔ new Steam anchor |
| 10398 | 10609 | Sea of Thieves PS5 ↔ new Steam anchor |
| 10336 | 10610 | Plague Tale Legacy PS5 ↔ new Steam anchor |
| 10372 | 10611 | LOTR WitN Legacy PS5 ↔ new Steam anchor (per Steve: Legacy Edition remaster is a real 2026 release, appid 2523770 valid, and has PS5+Xbox SKUs) |
| 10448 | 10612 | MGS Master Coll Vol.1 PS5 ↔ new Steam anchor |
| 10397 | 10613 | Black Myth Wukong PS5 ↔ new Steam anchor |
| 10386 | 10614 | Dying Light: The Beast PS5 ↔ new Steam anchor |

R6 Siege X: Elite (10394) dropped — Steam base is F2P, cannot anchor a paid Elite Edition pace curve.
Battlefield 6 (10310) — Steam appid not yet live (Oct 2026 launch); revisit post-listing.

Final: **10 seed rows + 14 bridges**. Xbox LOTR:WitN SKU (if present in DB) will auto-bridge via the exact-name matcher to Steam anchor 10611 without needing a manual line.

## Sequence

1. Live Steam Store API probe of the 10 appids (concurrent).
2. Write seed SQL for the 10 confirmed anchors; run `signalpulse-db-admin`.
3. Read-probe to confirm seeds landed (10 rows).
4. Edit `estimate-console-units.ts` MANUAL_BRIDGE (15 rows appended).
5. `npm run build` + `tsc --noEmit` locally.
6. `confirm_action` before push.
7. Push → deploy → trigger estimator → verify per-title d7/d30 signal
   populated → curl leaderboard route → screenshot check.

## What this does NOT fix

- MSRP for #76-100 LTD rows that lack MSRP entirely (Astro Bot, Silent Hill:
  Townfall, RE Requiem, Marvel's Wolverine, etc.). That's the Sony
  website-scrape follow-up, which requires the Playwright website-primary
  discovery job (Wave B Change 2).
- Titles with no Steam sibling at all (PS-exclusive Astro Bot, unannounced
  Silent Hill: Townfall). Those cannot be bridged and will keep showing as
  ltd-only-signal in non-LTD windows. That is honest and correct behavior;
  the fix for those is direct time-series estimation from PS5's own
  storefront rank movement, which is a separate estimator work item.
