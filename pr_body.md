## Summary

Two independent features built on the EnsembleData TikTok pilot:

1. **SignalPulse "TikTok Pulse"** — a new section mirroring YouTube Pulse (leaderboard, per-title detail, daily views/likes/comments snapshots, discovery via hashtags + keywords, unit-budgeted EnsembleData pipeline in a separate `tiktok.db`). Cron registered in `index.ts` (daily 04:30 America/New_York with 20:00 catch-up).
2. **SentimentPulse TikTok comment ingestion** — `tiktok_comment` SourceEnum, a service mirroring `youtube_service` that reads SignalPulse's `/api/tiktok/ops/comments-feed`, a per-title toggle "Collect TikTok Comments via Ensemble Data" on the Settings page, and 13 unit tests.

### Design decisions
- SentimentPulse and SignalPulse toggles are independent (separate keys, no coupling).
- SentimentPulse toggle: `AppSetting tiktok_comment_enabled:<game_id>` — **per-title only, no global fallback**, matching the "specific titles only" requirement. Default off.
- SignalPulse toggle: `tt_titles.enabled` in a separate `tiktok.db` — gates EnsembleData spending.
- Title universe: six Saber parents + DLC children + competitor children, per the user's list.
- Discovery: hashtags + keyword search.
- The focused-comment relevancy filter is active on TikTok comments during Step 5 classification (uses `is_comment_focused_on_game` plus a solicitation block). Comment text is the sentiment input; the video's desc is provenance only.

### Tests
- SignalPulse: 11/11 TikTok tests, 27/27 YouTube tests unchanged, full `npm test` passes, 79/79 frontend tests pass.
- SentimentPulse: 13/13 TikTok import tests (including two Step 5 integration tests proving the focused gate is active). Baseline on `main` was 20 failed / 1724 passed; this branch is 20 failed / 1729 passed — the same 20 pre-existing failures (verified by diffing failure IDs), plus 5 new tests that all pass. No regressions.
- Importer pagination is covered by strict finite mocks (no padding): terminal page causes exactly one request; budget exhaustion preserves the cursor and reports `page_budget`, never masquerades as complete.

### Deployment notes
- **Deploy isolation:** `signalpulse/` changes restart only SignalPulse; root/backend changes restart SentimentPulse. This PR touches both.
- Configure `tiktok_feed_base_url` + `tiktok_feed_ops_token` (or `INGESTION_OPS_TOKEN`) on SentimentPulse before enabling.
- The EnsembleData token stays in SignalPulse (env `ED_TOKEN` or AppSetting `tiktok_ensemble_token`); SentimentPulse never needs it.
- Per-title toggles default to off; no live collection starts on merge.

### Known gaps (disclosed)
- `runComments` currently pulls top-3 videos per title per run — bounded coverage, not complete title-level comment coverage. The bounded-sample caveat applies to SentimentPulse volume.
- Discovery cursor uses `page*20`; comment cursor uses `page*30` (matches the pilot's verified EnsembleData nextCursor semantics for those endpoints, but not re-verified against every endpoint's full contract).
- `runRetention` comment refresh is crude.
- Per-title seeds for Saber children/competitors are curated, not dynamically synced from SentimentPulse's configured parent/child relationships.
- Docs/CLAUDE.md lessons not yet written back.
- Toggle-independence is asserted at the key level (separate keys, no coupling); a full live four-combination test (SentimentPulse comments ON + SignalPulse video tracking OFF, etc.) is a follow-up before production activation.
