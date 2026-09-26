# YouTube resume repair

## Failure and contract

An immutable paginated feed snapshot can span daily runs. Finishing that old
snapshot is not proof of freshness. The importer now opens one fresh snapshot
after draining a saved window and reports `complete=True` only after the fresh
window is drained. This means all available eligible rows in that snapshot,
not that YouTube itself was exhaustively collected.

Each page and its cursor remain one transaction. A failure after the old
snapshot commits resumes from that watermark. A failure within a page retains
the last successful page. Publication dates, per-title ownership, tombstones
and duplicate protection are unchanged.

## Bounds

Daily: 100 pages of up to 500 rows, with a 120-second between-page time budget.
An in-flight request retains the existing (5, 30)-second HTTP timeout.
`stop_reason` distinguishes current completion, page budget and time budget;
`completed_through` identifies the last fully consumed snapshot.

Operator catch-up: explicitly selected active game IDs, 200 pages / 180 seconds
per title by workflow default. Existing ingestion must be idle, and the shared
maintenance lock prevents concurrent checkout resets/deployments.

## Scoped recovery

The workflow `sp-youtube-catchup.yml` runs `backend/scripts/catchup_youtube.py`.
It uses the existing internal feed credentials without printing them. No
YouTube API collection, Reddit, Steam or Bluesky fetch is initiated.

The script classifies unprocessed YouTube rows only, regenerates the selected
titles' current-day aggregates, queues dashboard cache refresh, and advances
per-game Top Topics generations. Other games' topic generations remain valid.
Partial imports retain committed pages but produce a failing workflow result.

## Acceptance checks

- Resumed old window followed by fresh window; both fully consumed.
- Budget exactly at transition reports incomplete, not successful.
- Failure on the first fresh request retains the old committed watermark.
- Large feeds can exceed ten pages; time/page bounds remain enforced.
- Replay, edits, tombstones, wrong-title rejection and publication dates.
- Targeted classification does not consume other-source backlog.
- Production reconciliation shows zero eligible upstream comments missing for
  the repaired titles at the inspected snapshot; all imported new rows are
  classified or deliberately excluded; dashboard and Top Topics refresh.
