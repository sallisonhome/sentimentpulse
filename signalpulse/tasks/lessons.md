# SignalPulse scoped regression lessons

## 2026-09-22: demo review scores must be demo-owned and non-overlapping

Use the demo App ID, never the parent game's reviews. A lifetime histogram
rollup and its recent daily buckets overlap; do not sum both for the score.
When weekly/monthly representations coexist, use one, not both. Recent-only
daily history cannot establish an old demo's lifetime score. Preserve genuine
0% positive separately from no reviews/unavailable and sort by the numeric
percentage before limiting rows. Label daily-cached scores as such.

## 2026-09-22: trial demo multipliers must preserve cohort boundaries

The user selected a 130x non-Saber live trial while preserving Saber's
65.5x baseline. Label a user-selected trial as such, never as an empirical
refit. Share rate selection between API and scheduled writer, recompute
from review deltas rather than scaling already-derived units, retain actual
protection, and apply the resolved values before sorting and limiting.

## 2026-09-22: demo review ratios need concurrency consistency checks

A single title's downloads/review anchor is provisional, not a universal
validated fit. Match downloads and all-language reviews to the same cutoff
before refitting. Never invent a higher global ratio from a CCU outlier.
Check the lifetime model against observed concurrency before ranking/display.
Where it fails, label the observed minimum explicitly, retain the raw review
estimate, and do not reuse that lifetime floor for a partial-lifespan window.
Keep activation categories out of demo-download calibration and ingestion.

## 2026-09-22: demo leaderboard coverage must match its named views

Parsing only the first embedded New & Trending block does not discover the
latest releases or most-played demos. Verify the actual browser feed for
each named view and its pagination. Persist independent source ranks and
timestamps; review/CCU sorts are not substitutes for Steam's Top Demos
(recent daily active users) or New Releases order. Test known missing
examples and no-review new releases, not just arithmetic on the old pool.

Per-title appdetails checks hit HTTP 429 when expanding the universe and
misclassify some software parents as games. Use batched Store Browse
metadata, verify demo + parent types, and share a cache only within one
pipeline run. Missing/failed metadata is not permission to include an app.
Retain the last complete feed snapshot on upstream/verification failure
and expose that failure rather than quietly relabeling old data as fresh.
Do not deactivate a freshly metadata-verified demo just because its review
histogram is absent. Software demos and license-category counts remain
outside the playable-game-demo pipeline.

Release dates must be the demo's, never the parent's. Label broad
Steam genre tags honestly, and apply genre filters and numeric/date sorts
before limiting API rows. Null values stay last in either sort direction.

## 2026-09-21: revenue authority and automatic application are separate contracts

Final anchored/model revenue must be resolved before displayed units. Recompute estimated units from that revenue and unrounded family ASP; preserve verified revenue/unit pairs through their realized ASP. Never pair raw pre-overlay units with final revenue or silently change stored training observations. Reuse one resolver across every Buying surface and sort after reconciliation.

Shadow mode never graduates itself. If the user wants automatic daily application, implement an explicit scheduled application stage, per-day audit ledger, eligibility gates, bounded adjustments, truthful visible status, and a kill switch. Do not apply today's mix to an entire historical period. Normal days return to the baseline; past applied dollar deltas remain scoped to their actual dates. Ratings are a proxy, not proof of a platform sale.

## 2026-09-21: an intermediate estimator field is not a second sales KPI

The owners count is the ratings-derived intermediate before the digital-share conversion to units. Raw revenue uses units × ASP; anchor/overlay revenue can override that independently. Present units and revenue, not both owners and units. Remove obsolete metric selectors and exports along with the card, while preserving internal fields and legacy APIs. Check unrelated surfaces before global deletion: hmap Genre Stats has a separate estimator that uses owners directly.

## 2026-09-21: update metadata can split a base game's platform family

No Man's Sky's paid base Steam/Xbox SKUs were enriched as Worlds Part II. A null legacy confidence flag bypassed the header guard, and Xbox's historical CTI seed froze the same enrichment error as if it were a verified store identity. PS5's actual base SKU then fell into a different family. Validate cached enrichment against the captured storefront name at read time, search from the storefront rather than a previous enrichment result, and never elevate an enrichment-seeded cache above exact-SKU store evidence. Test all five windows and regional SKU duplicates: units/owners/anchors are keyed by title and platform, not by regional listing.

## 2026-09-20: identity correctness does not establish artwork correctness

The Halloween metadata repair correctly rejected the unrelated IGDB title but reused a landscape storefront header as `coverUrl`. Checking title text and image presence was not sufficient QA. Keep landscape and portrait roles distinct, resolve official exact-SKU asset metadata rather than guessing CDN paths, measure native dimensions, and inspect the rendered portrait at desktop and mobile sizes on individual and combined PDPs. Browser fallbacks must reject wide/square assets rather than crop them to pass a visual shape check.

Shadow calibration must never be described as an already-trained revenue model. Persist raw evidence, peer coverage, rejection reasons and bounded proposals, while leaving live estimates unchanged until ground-truth validation supports activation.
