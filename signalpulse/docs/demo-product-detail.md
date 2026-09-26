# Steam demo product-detail pages

## Retirement tracking (September 26 update)

Publisher takedowns no longer stop demo tracking. The main metric views retain
retired demos, label their detected retirement date, and link to their PDPs.
`/demos-leaderboard/archive` is a separate retired-demo filter with search,
genre, numeric/date sorting and pagination. `/api/demos/archive` is authenticated.
Top/New source feeds remain available-only; Friends Pass behavior is unchanged.

The existing daily pipeline checks retired demos' own review/CCU endpoints and
all verified Saber download-report windows. No new schedule is added. Failed
sources retain last-good values; an all-zero retired histogram cannot replace
positive stored reviews. Only a successful review refresh advances retired
download estimates. Stale rolling estimates are unavailable in current-window
rankings; their original dated records remain accessible in the PDP.

`demo_titles.tracking_excluded_reason` separates invalid identities (software,
paid game, DLC, unverified manual rows) from retirement. Its additive migration
does not alter existing metrics or availability flags. `deactivated_at` means
first detected inactivity, not the publisher's exact takedown time. Unknown
pre-existing dates stay unknown; verified reactivation clears current retirement.

This update supersedes earlier lifetime-only/exclusion rules below.

## Scope

- Internal route: `#/demos-leaderboard/:appId`, linked from demo titles on the existing leaderboard.
- API: `/api/demos/titles/:appId?days=7|30|90|365|all`; separate `/media` endpoint.
- Both APIs remain behind existing human authentication. Friends Passes keep their existing links and are not silently reclassified as demos.
- Current headline downloads use the same resolver as the leaderboard: Saber official actuals, non-Saber provisional estimates, and explicitly labeled observed CCU minima.
- Charts, daily table, CSV, current period totals, IGDB cover/details/screenshots/trailers, and responsive light/dark layouts.

## Metric contracts

- **Saber downloads:** Verified own-demo Steamworks Downloads by Region reports. Never licenses, complimentary units or parent-game purchase/preload counts.
- **New actual history:** `demo_download_observations` retains the last successful observation per UTC date and report window. The additive migration seeds only an existing report's original fetched date. Failures keep the last good observation without fabricating a new one.
- **Daily actual changes:** Difference between consecutive observed lifetime reports only when capture dates and report-end dates are each consecutive and starts match. Includes reporting revisions and partial-day effects, so it is labeled a net change in observed LTD, not an audited daily-download report. Corrections can be negative; gaps and repeated report dates remain null.
- **Non-Saber estimates:** Daily own-demo review histogram buckets multiplied by the existing 130× trial. Recorded lifetime estimates preserve their original model and multiplier ID. No CCU floor is retrofitted into chart history.
- **Reviews:** Day-grain positive/negative review buckets are activity dates. Existing retained estimator review-count inputs and new `demo_review_observations` are capture dates. They are not interchangeable and need not have matching daily changes. Historical positive percentages are not reconstructed. Overlapping weekly/monthly review rollups are never added to day buckets.
- **Players:** Last daily CCU, sampled daily peak, and raw sample counts. Zero is measured zero; missing is null. Daily sampling is not continuous monitoring or a unique-player estimate.
- **Archived demos:** Only approved Saber lifetime download observations remain visible. No rolling-period, review or CCU activity is implied.
- **Cadence:** Existing daily collectors write the new observations. No new schedule, quota increase, discovery-scope expansion or one-time ingestion is added. Reload reads stored data only.

## IGDB

Exact Steam App ID matching via the existing server-side IGDB client. If no exact demo match exists, try a verified Saber roster parent or Steam Store Browse demo-to-game relationship. Reject ambiguous IGDB identities and software parents. Parent metadata is explicitly labeled and cannot change the App ID used for metrics.

The separate `demo_media_cache` uses a 24-hour success/no-match cache, a one-hour failed-attempt cooldown, per-title single-flight requests, and stale last-good media on errors. No credential is returned to the browser. Statistics remain usable when IGDB is unavailable.

## Verification before merge

- 290 automated tests passed across the existing regression commands plus `npm run test:demo-history`.
- TypeScript and production build passed. The existing bundle-size warning remains.
- Fresh and upgrade schema tests passed, including repeated migration. An isolated upgrade of an existing QA database preserved byte-equivalent serialized rows for 1,011 demo titles, 30 actual-cache rows, 550 window estimates, 3,891 review buckets and 306 CCU samples; SQLite integrity was `ok`.
- [Read-only production metric export](https://github.com/sallisonhome/sentimentpulse/actions/runs/36241738777) used to render representative Saber, non-Saber and archived demo pages.
- [Read-only IGDB/Steam identity probe](https://github.com/sallisonhome/sentimentpulse/actions/runs/36242062683) confirmed parent-media matches for Hellraiser, Docked and Toxic Commando. Character House returned no verified match and renders the no-match state.
- Browser checks: leaderboard-to-PDP navigation, all five ranges, all metric modes, CSV download, reload, screenshot/trailer dialogs and Escape/focus behavior, archived lifetime-only page, 404 retry, independent media failure, desktop/mobile viewport containment, and light/dark screenshots.

Synthetic tests cover corrections, daily gaps, genuine zeroes, original multiplier preservation, invalid IDs/ranges, excluded passes, failed refreshes, stale-media fallback, software-parent rejection and authentication. Synthetic metrics are not shown in the private preview.

## Deployment and rollback

Feature is not deployed until explicit squash-merge/deploy approval. Before production migration, take a consistent SQLite backup under the existing maintenance lock. After deployment, verify authenticated detail JSON, row-to-PDP links, source labels, migration row counts and the next daily collector's retained observations. No need to rerun discovery or ingest the catalog to initialize pages.

Rollback the application commit if necessary; the three additive history/media tables can remain safely in place. Do not delete observed history as part of rollback.
