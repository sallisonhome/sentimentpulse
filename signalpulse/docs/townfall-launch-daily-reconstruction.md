# Townfall launch-day recovery

This is a read-only, versioned reconstruction of dated sales estimates, not a
new actual-sales anchor, a fixed revenue ceiling, or a fabricated PS5 rating.
The reviewed scope is Steam title 10175 / App 1636440 and PS5 title 10774 /
JP0101-PPSA33286_00-TOWNFALLSIEJ0000. Konami confirms September 24 release and
48-hour early access:
https://www.konami.com/games/eu/en/topics/19323/

## Why

The September 30 read-only audit found no September 24 estimate rows. Steam's
September 24 bucket contained 432 reviews and was already included in all
current estimate windows. The old chart differentiated nonadjacent lifetime
snapshots, putting gap activity on September 25. It also used raw console
estimates instead of the public platform-share model:
https://github.com/sallisonhome/sentimentpulse/actions/runs/36661899153

## Contract

- Require exact reviewed paid-base identities, valid prices, continuous daily
  Steam activity from early access through the latest estimate date, and a
  reconciled lifetime snapshot.
- Require all five current saved windows to agree with the same deduplicated
  evidence and coefficient. A chart cannot quietly override a stale estimator.
- Allocate revenue-derived integer units within nested period bands using
  deterministic largest remainders. Daily sums equal all five published period
  totals, with no cumulative-seed or overlapping weekly-bucket duplication.
- PS5 dollar allocation uses the existing public Steam ratio and PS5 ASP;
  returned PS5 daily timing is explicitly modeled. No Xbox is synthesized.
- No fixed total or numerical anchor exists here. New evidence admitted by
  the normal estimator raises eligible totals. Repeating a refresh replaces
  the current projection; it never adds the launch allocation again.
- Protect manual overrides, Game Pass classifications, anchors, public-unit
  milestones and applied daily mix. Unreconciled/unsupported cases retain the
  normal API path rather than guessing.
- The general fallback now requires adjacent observation dates, includes an
  explicit null for missing dates, and loads predecessor history before
  slicing the requested date range. A multi-day delta is not a daily sale.
- Historical raw ratings, histogram buckets, estimates and lifetime state
  are not rewritten. No migration, backfill job or additional schedule exists.
- hmap relays the upstream envelope verbatim; no second sales formula.

## Rollback and operations

Set `LAUNCH_DAILY_RECONSTRUCTION_ENABLED=0`, or set existing `app_settings` key
`launch_daily_reconstruction_enabled` to `0` using an approved admin operation.
The durable setting is checked on every request. Clearing that setting or
setting `1` re-enables the projection without reimporting evidence.
This disables the scoped reconstruction, not the general gap safety rule.
Reverting the PR restores the old read behavior. There are no repair-written
sales rows to reverse and no collector/scheduler changes.

Production deployment is a separate approval gate after build/runtime/browser
QA. Verify both apps on all five periods and the actual chart requests after
their caches refresh; HTTP 200 alone is not sufficient.

## Pre-deployment QA

SignalPulse: 346 tests, typecheck and build passed. hmap: 17 tests and build
passed. The isolated production-schema replay exercised the real SignalPulse
HTTP routes and hmap proxy, including a nonempty upstream path prefix.
All five family periods reconciled to daily revenue and integer units; all
15 platform boards retained their published totals.

Two actual estimator/anchor-writer reruns preserved the reconstruction and raw
evidence. Disabling the setting restored the fallback. A separate synthetic
100-review increment raised combined LTD from $5,494,088.56248 to
$5,728,273.71608 exactly once; this was a test, not a production adjustment.
The clone was restored before browser QA.

Desktop (1440px) and mobile (390px) checks passed in both renderers: all five
period controls, daily range switching, launch-date tooltips, upstream units,
modeled methodology and responsive layout. The local sales-only QA harness
does not wire the separate ratings panel. Live post-deployment verification
remains outstanding; no production write or schedule change was performed.
