# Steam review-burst safeguard and bounded repair

## Scope

Keep the worldwide raw review population, percentages, labels, calibrated
multiplier and ASP policy unchanged. Only sales evidence is adjusted.
The safeguard is title-independent, not a Paradox exception and not proof that
individual reviews are fraudulent.

On each estimator run, each title's stored daily histogram is evaluated:

- Title at least 90 days old on the event date; known release required.
- At least 14 observed days and 100 reviews in the preceding 28 calendar days.
- Negative volume at least 100 and 8 times its prior median.
- Total activity at least 4 times its prior median.
- At least 80% negative, worsening by at least 35 percentage points.
- Keep every positive review and the greater of ordinary median negatives or
  negatives implied by current positive volume and the baseline negative/positive
  ratio. Exclude only excess negatives from the sales proxy.

The same exclusion is applied to overlapping rollup representations before
non-overlapping window selection. Daily, monthly and lifetime evidence must not
silently diverge. Inconsistent coarse rollups gate the sales estimate instead of
clamping an impossible subtraction to zero. Previously detected campaign days
do not normalize the next day's baseline; ordinary/proportional growth remains.
Stored daily observations are retained by the collector, so exclusions remain
reproducible after the upstream daily feed rolls forward.

All five windows use the screened signal. Daily platform-share evaluation
excludes an affected family from both application and cohort norms while the
campaign overlaps its 14-day evidence history. Raw reviews and sentiment are
never rewritten. Published estimates remain estimates, not verified sales.

## Repair approval

`scripts/repair-steam-review-shocks.ts` is read-only without `--apply`.
It imports no storage initializer and makes no startup writes.
The manifest requires:

- One paid base Steam app and a fresh, reconciled histogram snapshot.
- Mature accumulator state matching the latest saved lifetime estimate.
- A pre-event baseline within three days, with unchanged active coefficient.
- Each intervening unit increment fully explained by that coefficient and
  monotonic review increments.
- No revenue anchors, manual mappings or multiplier overrides.

Only the proven incremental excess above that baseline is removed. The repair
updates `title_ltd_state.ltd_units`, `last_signal_value`, `seeded_from` and the
update timestamp, and writes a per-title audit. It never rebases a mature title
from current reviews multiplied by the coefficient.

Apply requires explicit `--confirm CONFIRM --expected-sha` matching the reviewed
manifest. A full SQLite backup is retained before the transaction. Revalidation
inside an immediate transaction rejects stale/tampered plans.

## Deployment order

1. Confirm merge/deploy and the scoped state repair with the owner.
2. Check production service/collector state. Do not interrupt active ingestion.
3. Deploy SignalPulse first. Do not stop/start or alter the daily timer.
4. Generate a fresh dry-run manifest on production and compare its exact six
   expected title IDs and evidence with the reviewed audit. If any field changed,
   stop and review the new manifest before applying; do not auto-approve a hash.
5. Apply with backup and audit, then run the estimator with the existing
   accumulator configuration, without classification/discovery or multiplier refit.
6. Verify unchanged raw reviews, coefficients, anchors and overrides; exact
   repaired states; all five canonical API windows; rerun stability.
7. Deploy hmap's disclosure/changelog, then verify production parity and rendered
   notes. Its backend continues to rebroadcast SignalPulse without recalculation.

September 25 audit: 439 paid Steam mappings, 430 with review observations and
9 lacking observations. Six matched this safeguard: 10092 Stellaris, 10098
Crusader Kings III, 10111 Hearts of Iron IV, 10149 Cities: Skylines II, 10786
Europa Universalis IV and 10787 Cities: Skylines. No other observed title matched;
that is coverage of the captured catalog, not all Steam games. Captures end
September 24 because the separate September 25 discovery coverage gate failed.

## Rollback

Retain the deployed commit, approved manifest, repair run ID and backup path.
`--rollback --confirm CONFIRM --run-id` restores only audited states if each still
matches the exact after-state; it refuses any intervening state write.
Revert the estimator change and restore the scoped state together, then rerun the
prior estimator. A code-only rollback with the corrected signal watermark can
re-add the excluded campaign.

Once the estimator or collector has subsequently advanced state, automatic
rollback intentionally refuses. Generate and review a new scoped reconciliation
against the retained backup and current observations instead. Never restore the
whole database over fresh raw data, and never relax the conflict guard to force
a rollback. A full backup is evidence and a last-resort recovery artifact, not
permission to discard subsequent collection.

## QA inventory

- Pure gates: mature shocks, launch/sparse/unknown exceptions, proportional sales
  growth, ordinary negative sentiment, duplicates, future dates and stale rollups.
- Repair: dry-run no writes, unchanged raw/anchors/overrides, exact rollback,
  backup verified, repeated apply ineligible, stale/tampered manifests rejected.
- Fresh production-shaped fixture: six state repairs; all unaffected Steam
  estimate rows equal the main-branch estimator; two runs exactly stable.
- Real local Express endpoints: seven titles including Zero Company control,
  all five windows, individual/family revenue and revenue-derived unit parity.
  Top-100 board parity only where a title is actually returned.
- Built SP/hmap UI: desktop/mobile, five period buttons and return to 7d,
  individual/family adjustment note, no note on control, CSV and changelog.
- Typecheck, complete test suite, both builds, diff/conflict review.

Live post-deploy checks are a separate gate. Local screenshots deliberately
leave the unrelated Reviews and Ratings service unavailable; they do not prove
that external review-card service or the failed daily discovery refresh.
