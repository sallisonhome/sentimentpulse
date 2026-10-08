# Automatic collection opt-outs

The owner approved excluding EXODUS (3230960) and Toxic Commando Cosmetic Pack 1
(4148650) on October 8, 2026. The main Toxic Commando game (2157830) remains enabled.
Their YouTube title seeds set `collectionEnabled: false`. The other applications'
catalogues and non-YouTube sources are unchanged.

Opt-outs apply at database startup and every title sync, including partial syncs
and upstream catalogue outages. All automatic API-spending paths must honor
`yt_titles.enabled`: discovery, existing-video stats, new comments, old-thread
replies, and old-comment-text refresh. A discovery-only disable is insufficient.
Excluded DLC phrases must not suppress collection for an enabled parent game.

Stopping collection is not erasure. Retain videos, snapshots, raw comment text,
and existing SentimentPulse history. Do not tombstone records solely because the
owner stopped tracking a title. On-demand competitor lookup is a separate feature.

Regression checks: `tsx --test server/youtube/*.test.ts`. Verify live title flags,
unchanged historical counts, enabled parent, and no additional collector run or
quota consumption after deployment. Use the existing read-only YouTube query
workflow; never activate collection just to prove a configuration change.
