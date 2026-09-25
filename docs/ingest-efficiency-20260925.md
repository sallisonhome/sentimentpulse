# Earlier ingestion and transport efficiency

## Scope

User authorized both collection improvements and guarded 05:45 Eastern
ingestion. No data was purged, no collection limits reduced, and no full
second daily ingestion was triggered during deployment.

## Operational behavior

- `INGEST_HOUR_ET=5`, `INGEST_MINUTE_ET=45` are the defaults. Legacy
  server-clock fields are retained for compatibility but do not drive the
  daily trigger. Explicit `America/New_York` handles DST.
- The scheduled entry point checks `signalpulse-daily.service` and reads
  the upstream YouTube run table through SQLite read-only mode. It does not
  start/stop services. A partial YouTube run is logged as partial; failed,
  skipped, running, missing or stale producer state does not pass.
- Dependency checks retry every minute for one hour, then alert and do not
  start conflicting work. Existing manual run controls remain unchanged.
- Reddit transport gets a connection pool and a bounded run-local LRU for
  identical successful responses. Failures are never cached. Payloads are
  decoded separately per caller so annotations cannot cross game boundaries.
- A successful empty archive query does not need another archive query.
  Primary errors retain any available posts plus fallback posts, mark partial
  coverage, and do not move the primary cursor. Comment failures are visible
  in run errors rather than reported as genuine zero-comment results.
- Provider pacing is shared across ingestion contexts. Retry-After is honored;
  cooldowns over two minutes fail individual reads visibly instead of blocking
  a worker indefinitely. Existing daily retry/catch-up remains available.
- Monthly related/popular-upcoming jobs recheck once a minute after their
  existing due hour on the first day, without consuming the month marker until
  SentimentPulse is explicitly idle. Sunday SKU linking now fires at 15:15 UTC
  and fails closed if a delayed/manual ingestion is still running.

## Verification

- Backend: 1,595 passed, 5 expected failures. Existing static-fallback test
  fixture made deterministic: an incidental empty local DB previously selected
  a different branch than its documented fallback scenario. Production
  relevance logic was not modified.
- Ingestor health checks and application import passed.
- SignalPulse TypeScript check/build passed, plus 11 coordination/daily-run
  tests.
- Real anonymous Arctic Shift smoke read: 100 rows returned, complete=True.
  Repeating the identical read used one total HTTP request across both calls
  and returned the same row count from the run cache.
- Summer and winter trigger tests verify 05:45 Eastern (09:45 / 10:45 UTC).

## Rollout acceptance

After deployment, verify next_run_at is September 26 at 09:45 UTC, inspect
dependency state from the host, and run the non-writing transport smoke.
Compare the first full scheduled run against the measured 140–160 minute
baseline using ingest_phase and reddit_transport metrics. Verify all active
titles were visited and no failures were silently converted to success.

The new schedule does not by itself promise completion before the existing
07:00 report consumers. Those schedules are unchanged in this change set.
