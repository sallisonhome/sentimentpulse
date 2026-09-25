# Daily refresh hardening

## Diagnosis

The September 25 host timer fired on schedule but PHASE 1 failed with 45 freshly
classified Steam paid candidates against a fixed minimum of 80. Its journal also
recorded repeated HTTP 429 appdetails failures. Previously verified paid rows were
correctly preserved by the September 24 safety patch, but the discovery gate did
not count that preserved evidence. Collection never started.

The old GitHub daily schedule was still active as well as the host timer.
GitHub's default single-pending concurrency queue can cancel waiting workflows,
even with cancel-in-progress disabled. Host timers do not participate in GitHub
concurrency groups.

Read-only host audit:
https://github.com/sallisonhome/sentimentpulse/actions/runs/36136197048

GitHub queue contract:
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax

## Scope and safeguards

- Count only current Steam discovery candidates with fresh paid classification or
  retained paid-base evidence after unavailable metadata. Keep the minimum 80,
  Xbox minimum 80 and PS5 minimum 90. Never use unrelated catalog rows to pass.
- Stop appdetails requests after HTTP 429, and pace all attempted requests,
  including early-return branches. Unknown new SKUs remain unknown. Explicit
  non-game evidence is not treated as unavailable metadata.
- Production discovery skips synthetic test inserts. Production collection does
  not seed IDs, overwrite catalog classifications, or delete legacy rows.
- Require fresh observations in each platform's current invocation and at least
  80% successful requests, excluding explicit storefront no-data soft skips.
  Report individual failures and skips; do not claim every SKU refreshed.
- Expand collection's cap from 360 to 1800 seconds; retain individual caps and a
  3600-second service ceiling, including a bounded 600-second lock wait.
- Keep one automatic refresh owner: signalpulse-daily.timer at 09:15 UTC.
  The old GitHub workflow becomes a manual alias to the same systemd service.
- All deploy-droplet workflows use queue:max and cancel-in-progress:false.
  Queue capacity remains GitHub's documented 100 pending jobs, not unlimited.
- The timer, all four shared-checkout deployments, scheduled anchor writes,
  weekly linking and Xbox enrichment share a host flock. Deployments wait
  before any git reset or package installation. Xbox enrichment defers to the
  next hourly slot when busy. No kill, stop or restart of a competing refresh.
- Manual verification requires a new invocation, successful service result and
  exit, all five phases, and a completion marker in that invocation's journal.

## Local and live-upstream QA

- Full automated suite: 245 tests passed, including real concurrent flock
  processes, five distinct phase failures, stale-success rejection, missing
  completion, failed systemd result, duplicate trigger rejection, queue/schedule
  invariants, classifier circuit breaker and classification preservation.
- TypeScript, production build, workflow YAML, embedded bash syntax and diff checks.
- Isolated copy of the production-shaped console fixture; no production DB writes:
  live discovery returned 44 freshly classified Steam paid candidates plus 148
  preserved paid-base candidates, 100 Xbox paid and 102 PS paid.
- Live collectors against that isolated DB: 440 Steam, 279 Xbox and 330 PS5
  observations; zero request failures; one explicit PS5 no-data skip.
  Collection took approximately 504 seconds, exceeding the old 360-second cap.
- Local estimator, anchor writer and daily mix stages completed on those captures.
  The fixture has no publisher sales actuals, so the anchor writer correctly
  wrote zero anchors; this does not prove production anchor coverage.
- Collector completion left library handles alive in the first rehearsal;
  CLI now explicitly exits only after its awaited run and checks finish,
  matching the existing discovery/estimator CLI convention.

## Controlled deployment and verification

Merge only after operator approval. Use a squash message containing [skip ci]
to prevent workflow-only changes from automatically restarting unrelated suite
apps. Then explicitly dispatch only SignalPulse's deployment, update installed
daily units while idle, and run the canonical manual refresh. Keep the existing
timer active; no disable/re-enable cycle is required.

Require live installed unit and scheduling checks, new invocation success through
PHASE 5, fresh production captures, and public SignalPulse/hmap API checks before
calling the refresh fixed. Do not confuse local upstream QA with production proof.

## Rollback

Revert the application/script changes and redeploy SignalPulse if necessary.
Retain the queue and host-lock protections and the sole-timer schedule; reverting
the entire patch would reintroduce the known duplicate and cancellation hazards.
Do not restore a database snapshot: this patch performs ordinary collection and
estimation, not a lifetime repair. Preserve the earlier six-title repair/audit.
