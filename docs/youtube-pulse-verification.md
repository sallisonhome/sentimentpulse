# YouTube Pulse: implementation and verification

This feature branch is not deployed. The API key is in an encrypted GitHub
repository secret; the manual provisioning workflow has not been dispatched.
No production database was modified during this work.

## Retention

- Tracked video records, daily video-count snapshots and raw comment text have
  no age-based purge. A legacy `policy30` setting cannot enable erasure.
- Upstream removals and relevance failures mark records excluded. Existing
  snapshots and raw text remain. Sentiment records derived from excluded
  comments are removed so they cannot pollute the dashboard.
- Current text is updated when edits are observed; this is not a revision log.
- Rejected-search candidate caches can expire to allow re-evaluation. They are
  not admitted video history. One-off lookups do not enroll a title in tracking.
- Permanent retention is an owner-requested application behavior, not a
  determination that private use changes YouTube's contractual requirements.

## SentimentPulse comment source

All active games, including competitor children, use the same importer.
Steam app ID maps comments to the child's own game, not to its Saber parent.
The parent relationship remains intact for comparison views.

The importer uses version 2 of the ops-token feed. Each page and its cursor
commit together. Retries deduplicate IDs; unfinished pagination resumes.
Video titles provide provenance, not the sentiment input. Spam and off-topic
comments are retained but excluded from sentiment and qualified source counts.
`YouTube Comments` is present in Posts by Source, the volume chart and post
filters. Current/prior period counts include this source and reconcile with
Total Posts, using the comment's original publication date.

### Activation, after deployment approval

1. Back up both databases and apply migration 0021 (SQLite requires no enum DDL).
2. Run the approved key provisioning workflow separately.
3. Configure `youtube_feed_base_url` (default loopback `http://127.0.0.1:5000`)
   and secret `youtube_feed_ops_token`, matching SignalPulse's
   `INGESTION_OPS_TOKEN`. Non-loopback transport must be HTTPS.
4. Set `youtube_import_enabled=true` in AppSettings or
   `YOUTUBE_IMPORT_ENABLED=true`. Default remains false.
5. Collector runs daily at 04:30 America/New_York, with startup catch-up until
   20:00. Consumer runs in SentimentPulse's existing daily ingestion before
   classification. Verify the deployed ingest hour/timezone occurs after the
   collector; code defaults alone do not prove production timing.
6. Inspect fresh video snapshots, comments, persisted consumer cursors, source
   health and dashboard rows on both a Saber and competitor title. A success
   log alone is not proof of source completeness or daily production behavior.

Collection is quota bounded. Top-level and reply pagination retain continuation
tokens; older threads rotate for new replies. Daily polling also handles
unchanged headline comment totals. An initial backfill can take multiple runs.

## SignalPulse title history

Click a title in the leaderboard to open its YouTube PDP. The disclosure arrow
still opens a quick video list without navigation.

- Publication & comments: discovered videos and stored comments, bucketed by
  their original UTC publication dates. These are known-record counts and can
  grow through backfill, not complete YouTube-wide activity.
- Daily snapshots: video sample size, reported lifetime comments and views on
  each bucket's final day. Missing observations remain blank.
- Velocity: same-video net changes between consecutive UTC dates. New videos
  without a baseline do not create fictitious growth. Negative corrections
  remain negative; this is not gross newly authored comment volume.
- Range controls: 7/30/90/365-day shortcuts, custom inclusive dates and
  day/week/month buckets. Weeks start Monday; edge buckets are clipped.
- Optional archived scope: includes retained excluded data. The default
  restates history using current relevance, rather than pretending to preserve
  the historical relevance decision.
- CSV: generated from the currently displayed response, including every chart
  metric, exact applied range, bucket, scope, UTC timezone and generation time.
  Draft edits disable export until applied. Null is blank, not zero. Formula-
  like title strings are escaped for spreadsheet safety.

## QA inventory and results

- Real local feed: 19,452 admitted comments imported; all 43 configured games
  completed their snapshots. Five dashboard periods reconciled for every game.
- Local API metadata recheck: 229 of 2,886 videos excluded; all 2,886 video rows,
  2,886 daily snapshot rows and 21,837 raw comment rows retained. 2,385 comments
  excluded. The importer starts with the remaining relevant feed.
- Ambiguous-title regressions include John Wick, Docked, Road Kings and hashtag
  boundaries. All 183 earlier John Wick matches were excluded; zero accepted
  rows is an honest conservative result, not evidence that no true videos exist.
- Tests cover importer retries/ownership/edits/exclusions, source counts across
  all periods and parent-child separation, daily unchanged-total polling,
  feed snapshots, retention beyond 30 days, time-series gaps/boundaries and CSV.
- Browser inventory: click-through/back navigation, presets, custom dates,
  invalid/reversed dates, all measure tabs, bucket choices, archived scope,
  refresh, exact CSV contents, unknown title/empty snapshot state, desktop/mobile
  fit and light/dark appearance. No invented historical daily observations.
- Final checks: 141 SignalPulse tests, 61 frontend tests and 56 focused backend
  tests passed. Both production builds, TypeScript, ingestor health/bytecode
  checks, import smoke and SQLite migration 0020-to-0021 rehearsal passed.
  Existing frontend bundle-size warnings remain.
- Browser verification completed for desktop and 390px mobile, light/dark,
  date validation, all modes, weekly/monthly aggregation, archived scope,
  refresh/back navigation and unknown-title state. Source-card counts for
  Space Marine 2 matched 302/1,209/3,824/3,824/3,824 across Today/7d/30d/90d/All
  in this isolated YouTube-only test copy. Competitor empty-state breadcrumbs
  and counts were checked; positive competitor ingestion is fixture-tested,
  not yet live-verified.
- Browser-downloaded custom-range CSV matched every API metric for all five
  selected days. Actual final JSON/CSV API routes returned 200, invalid date/
  bucket ranges returned 400 and unknown titles returned 404. Charts showed
  only the one observed daily snapshot, with no invented velocity baseline.

## Remaining release gates

Successful live one-off competitor search remains quota blocked. Fixture search
and the real quota-error path are covered; they are not substitutes for a live
successful search. Newly configured competitor collection needs production
verification after activation. Confirm scheduler ordering and observe a daily
run after deployment. The leaderboard remains publication-cohort based;
velocity is available on each title PDP, not a portfolio ranking mode.
