# SignalPulse scoped regression lessons

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
