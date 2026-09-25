# Daily sales platform coverage

## Scope and data contract

The existing `signalpulse-daily.service` runs catalog reconciliation in phase 1b,
after discovery and before collection. It uses the same maintenance lock as the
existing refresh and deployments. No additional timer, scheduled workflow or
request-path writer is introduced.

The job examines the entire known catalog, without a Top 20/40 cutoff:

- Verified ratings-only records from the reviewed portfolio and CCU imports.
- Nonmanual base-game records whose business model is unknown.
- Missing Steam records identified by existing exact, reviewed storefront links.

It does not invent unannounced platforms, search-match arbitrary titles, remove
manual holds, or assert that every game in the world has been discovered. Missing
or ambiguous storefront identities need review. Previously admitted base games
continue through the normal daily collectors and estimator.

## Admission and duplicate guards

Each admission requires the exact native SKU/App ID, console compatibility where
applicable, a released date, a paid base-game product and unambiguous USD retail
MSRP. A PlayStation regional listing may use another USD listing only in the same
verified concept and base identity. It never uses an unrelated page price or
treats another currency's number as dollars. Game Pass/subscription offers alone
do not establish a paid retail sale.

An existing paid base on the same platform blocks another admission when the
title ID, family, normalized identity, reviewed Steam identity, or PS concept is
already covered. The projected batch gets the same checks, followed by a complete
recheck inside `BEGIN IMMEDIATE`. Positive real title IDs are identities; temporary
zero IDs are not. Exact-SKU uniqueness and atomic title-ID allocation protect new
Steam rows. Meaningful sequel/remake/year distinctions are preserved.

No reviews, ratings, lifetime state, anchors or multipliers are copied or modified
by reconciliation. Revenue and units remain the existing estimator's outputs.
Subsequent collection may add genuine observations normally. Null or zero estimates
remain possible when sales signals are insufficient; eligibility is not a promise
of nonzero sales.

## Controls, receipts and rollback

Settings key `sales_catalog_reconcile_mode`: `active` (default), `plan`, or `off`.
The script also accepts `--plan`; an environment override exists for operations.
Invalid modes fail loudly. Source failures hold the affected records and are
printed separately from eligibility holds; inspect the receipt's error count.
Verification has a three-minute soft budget with bounded native requests and a
four-minute phase ceiling. Exhaustion leaves the remaining candidates unchanged
and marks coverage partial, while established collectors can continue. Verification
order rotates daily within the Steam-first cohorts to avoid starving the same
tail of the catalog after repeated provider failures. A completed refresh is not
proof of complete new-platform coverage when that receipt says partial.

Each run writes a durable JSON receipt under `catalog-coverage-audit/`, with
before-images, native evidence, decisions and applied after-images. Active writes
require a completed SQLite backup first. Keep the newest three completed backups
created by this job; JSON receipts and interrupted-run backups are retained.
Backups are not an automatic whole-database restore mechanism.

Rollback procedure:

1. Set the Settings mode to `off`, ensure no environment override forces active,
   and acquire the existing maintenance lock through approved operations tooling.
2. Invoke the script with `--rollback` and the exact completed receipt path.
   Roll back receipts newest first. Every current row must still match its
   recorded after-image, or the whole rollback aborts.
3. Existing rows regain their old catalog fields. Newly enrolled Steam rows stay
   in the database as manual ratings-only holds, retaining any later observations.
   No history, user data or newer estimates are deleted.
4. Run the existing locked daily refresh to recalculate derived results, then
   verify board/PDP parity and platform coverage in both apps.

If a process dies after the transaction but before completing its receipt, do not
blindly retry or restore the database. Inspect the prepared before-images and
current catalog under the lock; reconcile that interrupted audit explicitly.

## QA and rollout

The test suite covers duplicate families/concepts/regions, multiple new Steam
rows, unchanged reruns, manual holds, stale or changed evidence, native SKU and
offer rejection, atomic rollback and competing refresh serialization.

The September 25 read-only production catalog audit found 1,202 mappings. A local
production-shaped database replay proposed 120 corrections: 63 Steam (including
seven new exact-ID rows), 20 PS5 and 37 Xbox. Two candidates were already covered;
104 remained held and no native request failed. Repeating the local application
made zero further writes. Protected source/history/anchor tables stayed unchanged.

Local HTTP QA exercised ten representative families across d7/d30/d90/m12/ltd:
combined sums, board/PDP parity where in Top N, individual/PDP parity, revenue-derived
units, and unique platform/title observations. Townfall retained Steam and PS5 only.
The entire 120-row admission set also passed an explicit same-platform duplicate
audit and a full rollback against the production-shaped schema, with protected
histories unchanged. New family aliases introduced no existing same-platform
collisions.
The final suite passed 255 automated tests, TypeScript checks and both app builds.
An additional real command-line round trip on the isolated database verified
backup creation, active writes, the off switch, refusal to roll back while active,
and exact catalog restoration without changing ratings.
These are predeployment checks, not claims of live rollout. Production approval,
deployment, a fresh daily invocation, database receipts, and public SP/hmap checks
are still required. Audit source:
https://github.com/sallisonhome/sentimentpulse/actions/runs/36154839252
