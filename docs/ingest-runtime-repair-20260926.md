# Ingestion runtime and scheduling repair

## Verified production findings

The September 26 run started at 06:48:35 UTC / 02:48:35 Eastern because startup
recovery used a 20-hour age threshold, not the configured daily slot. At
09:45 UTC / 05:45 Eastern, the scheduled function raised ImportError for
`youtube_import_enabled`; the real function is `import_enabled`.
The traceback and startup log are in the [read-only diagnostic receipt](https://github.com/sallisonhome/sentimentpulse/actions/runs/36252808869).

Of the 12,264.651-second run, logged stages included 5,884.255 seconds in
Reddit posts, 3,942.452 in Reddit comments, 1,396.610 in Steam forums,
156.342 in classification, and 217.820 in daily summaries.
Transport recorded 3,374 requests, 416 HTTP 422s, 179 HTTP 429s and only
24 cache hits, per the [timing receipt](https://github.com/sallisonhome/sentimentpulse/actions/runs/36252720609).

The old transport treated repeated query timeouts as a global cooldown:
5 seconds before the second attempt and 10 seconds before unrelated subsequent
requests, even without a server instruction. The 1.8-second courtesy floor
also slowed the large comment sweep. This explains avoidable delay, not every
second of run-to-run variation. The API documents dynamic rate limits and
X-RateLimit-Reset / X-RateLimit-Reset-At headers in its
[official reference](https://raw.githubusercontent.com/ArthurHeitmann/arctic_shift/refs/heads/master/api/README.md).

## Change boundaries

- Keep 05:45 America/New_York, including DST. Do not move other suite schedules.
- Route startup through the same guarded function; serialize the automatic
  admission and dependency-wait envelope. Recheck live state before execution.
- Treat an already finished success/partial/partial_failure spanning the
  current slot as attempted, not a reason to rerun the portfolio after deploy.
  Preserve interrupted/error recovery after the slot.
- Fix the runtime enablement import and handle explicit ingestion error returns.
- Keep two transport attempts, configured source/title scope, parent/comment
  caps, 48-hour overlap and source fallback behavior. Never mark a failed read
  empty or advance its cursor.
- Remove synthetic 422 global cooldowns, respecting explicit Retry-After.
  On 429 honor actual reset headers, including millisecond reset timestamps.
  Keep bounded long-cooldown failure rather than indefinite worker sleeps.
- Restore Arctic Shift's one-second courtesy floor. Log actual HTTP time,
  pacing time, and per-provider response statuses for the next comparison.

## QA

Backend suite: 1,639 passed, 5 expected failures. Ingestor health checks and
application imports pass. The actual scheduled and startup functions execute
in regression tests, not merely their CronTrigger constructors. Tests cover
the observed early start, summer/winter slots, finished-run restart suppression,
interruption recovery, concurrent entries, dependency failure and recheck,
422 isolation, explicit Retry-After and provider reset headers.

A non-writing production-host probe requested the same 12 parent threads using
both pacing settings: 474 identical comment IDs, 12 HTTP 200s and zero errors
in each pass. Elapsed time was 21.496 seconds at 1.8-second pacing versus
13.215 seconds at 1-second pacing. HTTP/cache warmth also differs between
sequential probes; do not extrapolate this percentage to a full run.
See the [equivalence receipt](https://github.com/sallisonhome/sentimentpulse/actions/runs/36253060613).

No frontend contract or database schema changes; client rendering and schema
migration QA are not applicable. No production ingestion/data mutation was
performed for these tests.

## Deployment and acceptance

Merge only after approval. The existing deploy workflow restarts shared suite
services, not just this module; first confirm ingestion and upstream jobs idle.
Deploying today must log `daily_slot_already_completed` on startup, not run a
second full ingestion. The next daily trigger must be September 27 at 05:45 ET.

Read-only verification from backend:

```bash
PYTHONPATH=. .venv/bin/python scripts/verify_ingest_runtime.py
```

After the next unattended run, require all active titles visited, record source
and incomplete-query counts, compare elapsed time to 12,264.651 seconds and the
pre-change 9,601-second baseline, and check Today YouTube coverage. Do not call
faster-but-less-complete ingestion a success. Reddit keyword queries still
time out at the provider in direct probes, so eliminating local waste does not
guarantee complete archive coverage or a particular full-run duration.
