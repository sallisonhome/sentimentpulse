# Steam catalog cooldown and unnamed-App-ID recovery

## Scope

This change coordinates Steam appdetails requests in sales discovery and sales
catalog reconciliation. It does not change multipliers, review scope, weekly
fallback policy, revenue-share learning, lifetime accumulation, service schedules
or the hmap API contract. Other Steam subsystems are not routed through this gate.

## Runtime behavior

- Both phases use the same operational SQLite file, defaulting to
  `.steam-catalog-cooldown.sqlite` in the SignalPulse working directory. The daily
  wrapper exports its absolute path through `STEAM_CATALOG_COOLDOWN_PATH`.
- HTTP 429 immediately persists a provider deadline and defers metadata. A valid
  503 Retry-After also defers. Numeric and HTTP-date headers are supported; missing,
  malformed, expired or sub-minute 429 headers use a 60-second minimum.
- Later processes check that deadline before pacing and again before HTTP.
  Concurrent state updates cannot shorten it. Ordinary 502/503/504 responses
  retain bounded retries; a long Retry-After is persisted even on the final try.
- Corrupt, locked or unwritable operational state defers metadata without HTTP.
  SQLite releases locks after process death. Do not delete an active cooldown to
  force progress. Existing deployment uses git reset, not cleanup of ignored
  runtime files, so this ignored state survives ordinary deployment.
- Deferred reconciliation is reported as partial coverage, not complete coverage.
  This does not mean the whole daily refresh failed; its downstream ratings and
  estimate phases continue under the existing maintenance lock.
- Reviews/histograms remain independent of this appdetails cooldown.

## Identity and duplicate protection

Only an existing numeric Steam App ID with an unnamed, non-manual, unknown base
row qualifies for identity recovery. The response must include that exact
embedded Steam App ID and a nonblank native name. It must still prove a released,
non-free base game with a positive integer USD list price; editions, DLC, demos,
preorders, free products, ambiguous or unavailable metadata remain held.

The recovered name is checked against existing same-platform family coverage and
earlier candidates in the same plan. Apply repeats those checks inside the write
transaction. Recovery fills metadata under the existing title ID and promotes
that catalog row; it never copies rating history, estimates or lifetime state.
An unavailable Steam response is not permission to infer a paid title.

## Deployment and rollback

Build/QA authorization is not deployment authorization. Deployment remains
pending explicit owner approval. No new recurring job is needed; the existing
daily phases consume these changes.

Before deployment, retain the reviewed diff and run the full tests, typecheck,
build, runtime replay and shell syntax check. After an approved deployment,
verify the new service invocation, phase logs, completion marker, per-platform
fresh observations and coverage receipts. Confirm held/deferred rows remain
unknown, recovered identities have native evidence, and both apps agree.

For rollback, first disable reconciliation using the existing
`sales_catalog_reconcile_mode=off` operational procedure, with owner approval and
the existing maintenance lock. While this version's rollback implementation is
still installed, use the existing reconciliation `--rollback` command with the
specific completed receipt. Do not revert code first: older rollback code does
not know how to restore `metadataRecovery` before-images.

Rollback compares catalog and metadata after-images. It restores only fields
owned by this recovery and removes a newly inserted metadata row only when its
entire after-image still matches. A later metadata writer causes an atomic
conflict, not an overwrite. Investigate that conflict rather than restoring the
whole database. Raw observations and fresh estimates are never deleted by this
rollback. Recalculation, code reversion and reactivation each require the usual
approved, locked operational workflow. Preserve existing cooldown deadlines.

## QA evidence contract

Automated tests cover throttle expiry, Retry-After formats, corrupted/blocked
state, abrupt writer death, real discovery/reconciliation process separation,
independent ratings requests, paid-evidence preservation, exact-ID rejection,
duplicate families, concurrent changes, idempotence and rollback conflicts.

Catalog replay uses a local copy of production-derived data and the 28 unnamed
App IDs from the September 26 export. Native metadata in this replay is synthetic
and explicitly labeled; it proves the recovery mechanism, not that those 28
products are eligible in production. The replay checks protected input hashes,
exact rollback, a same-day control writer cycle, two post-recovery writer cycles,
all five period views and both applications' actual local API handlers.

No UI code or API shape changes are included. hmap uses its existing pass-through;
no separate hmap deployment is required for this backend-only change. Real Steam
availability and production recovery counts remain post-deployment observations,
not claims inferred from fixtures.
