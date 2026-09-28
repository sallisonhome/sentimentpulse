# Reddit collection and digest relevance repair

## Collection contract

Daily bounded general-subreddit reads paginate ordinary archive listings,
select the same single keyword in title and selftext, and then apply the
existing game-mention gate. The newest configured number of hits per field
remains the contract. The requested lower date bound is never shortened.
The upper publication bound is frozen at run start.

Pages are shared across titles in a temporary compressed SQLite cache, bounded
to 64 MB of compressed payload. Annotation copies cannot leak across games.
The scan is limited to 1,000 pages and a 600-second between-page budget per
scope; active HTTP calls and prescribed rate-limit waits can extend that soft
budget. Partial reads retain available rows and keep their checkpoint unchanged.
Same-second pagination saturation is partial rather than silently skipping IDs.

Only exhausting the entire requested interval earns a checked-through
watermark, including a proven empty interval. Satisfying the existing per-field
caps is not an exhausted-window proof. Save errors also block checkpoint
advancement. Backfill and non-run callers retain their existing request path.

Source health is partial when explicit incomplete Reddit reads coexist with
successful fetched rows. Older persisted results are corrected on read without
rewriting their original run status, errors, dates or volumes.

## Relevance contract

The shared broad-community set covers generic recommendation and simulation
communities, including the distinct `gamesuggestions` spelling. Those boards
are keyword-gated at collection and tagging; they are not dedicated game
communities. Existing qualified game mentions and legitimate comparisons remain
eligible. No game-name blacklist is used.

Both period-summary evidence samplers reject noise, off-topic drift and
explicitly rejected rows before ranking samples. This prevents an already
excluded comment from resurfacing merely because it has a SentimentRecord.

## Audited correction procedure

`backend/scripts/repair_game_relevance.py` defaults to a read-only plan.
Applying requires the exact reviewed SHA-256 of the scoped before/after plan.
The operator refuses a running/unknown ingestion. Offline maintenance requires
the SentimentPulse service to be fully stopped.

Before mutation, the operator writes a protected gzip audit containing every
affected row's before/after flags and the affected derived-cache records.
No raw posts or sentiment records are deleted. It changes only the requested
game's broad-community posts and their linked replies, preserves explicit game
mentions, and invalidates that game's DailySummary, MonthlySummary,
WindowSummary, TopicTrend and Top Topics cache generation.

For production correction, check idle state, take the shared maintenance lock,
stop SentimentPulse, apply the approved plan, and restart in a guaranteed cleanup
path. This prevents an old synthesis worker or in-memory digest preview from
putting pre-repair text back. Rebuild and inspect the digest only afterward.
The script itself never sends email or collects sources.

## Verification

- Combined backend suite: 1,680 passed, five expected failures.
- Frontend suite: 71 passed; production build and ingestor static checks pass.
- A source replay completed every originally failed scope at its original lower
  bound. Verification used captured pages across two passes, not a full nightly
  run; no production writes occurred in that replay.
- Regression coverage includes empty intervals, both fields, overlapping pages,
  malformed data, budget/failure checkpoints, bounded cache cleanup, exact-plan
  refusal, idempotent quarantine, preserved raw/classification rows, genuine
  game mentions and cross-game isolation.
- The Settings partial-health state is rendered and tested. The existing
  narrow-screen fixed-sidebar layout is not redesigned by this patch.

Full unattended runtime and coverage must still be measured after deployment.
A faster source probe is not proof of a faster or complete nightly portfolio run.
