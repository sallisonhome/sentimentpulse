# Saber Steam CCU Leaderboard — Implementation Plan (Plan Mode Default)

Status: IMPLEMENTED — approved 2026-09 (ask_user_question: "Approved, proceed"). Backend, CCU
leaderboard tab, and PDP additions are all built, `tsc --noEmit` clean, `npm test` 22/22 pass, and
local-dev-verified with seeded snapshot data (screenshots below). Not yet committed/pushed/PR'd —
see §8 for outstanding QA notes and the delivery checklist status.
Owner acknowledgment: re-read `howmanyareplaying/PRINCIPLES.md`, `howmanyareplaying/tasks/lessons.md`,
`sentimentpulse/CLAUDE.md`, `sentimentpulse/lessons.md` before starting this feature (standing rule).
Applicable rules invoked below: Plan First + verify with user (CLAUDE.md Task Management), Confirm Steps
Before Irreversible/Cross-Cutting changes (CLAUDE.md §10 — new tables, new tab, new 60-min cron all qualify),
IGDB `external_game_source=1` matching rule (lessons.md), mutability-gated release detection — never infer
release status from a proxy signal (lessons.md), QA before every commit/push/deploy (CLAUDE.md/lessons.md),
no raw `DELETE FROM steam_sales_daily` (N/A here — different tables), squash-merge PR workflow (CLAUDE.md §11).

## 1. Source-of-truth patterns being ported (from howmanyareplaying, read this session)

| Concern | howmanyareplaying source | Port target |
|---|---|---|
| 60-min CCU poll | `backend/src/scheduler/pollLive.js` | new `server/ccu-poll.ts`, Saber-scoped |
| Combined leaderboard endpoint | `backend/src/routes/leaderboards.js` | extend `server/leaderboards.ts` with a `ccu` board |
| Countdown timer UI | `frontend/src/components/ui/CountdownTimer.jsx` (+ css) | verbatim port, same UX contract |
| CCU history + hourly pattern | `backend/src/routes/history.js` (`/hourly`, range filters day/week/month/3m/6m/1y/all) | new `server/ccu-history.ts` routes |
| IGDB media + summary | `backend/src/services/igdbApi.js` (screenshots/videos/summary fields) | extend `server/igdb.ts` (already has hype-only fetch — add a media fetch fn using the same batching/retry) |
| Media carousel + lightbox | `frontend/src/components/detail/GameMedia.jsx` (+ css) | verbatim port |
| "Top 5 Steam crossover games" | `frontend/src/components/detail/GameIgdbRelated.jsx` is actually IGDB similar/DLC/remaster sections — the real "Top 5" widget is the SteamHunters-based related-games block documented at `games.js` `/api/games/:appid/related` (achievement-overlap "morelike" pool), precomputed monthly | new precompute job + `server/ccu-related.ts`, same 5-card grid design |

## 2. Data model additions (`shared/schema.ts`)

New tables, following the existing `(productId, date)` pattern already used for `steamWishlistDaily` etc.:

```ts
export const ccuSnapshotsSteam = sqliteTable("ccu_snapshots_steam", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  capturedAt: text("captured_at").notNull(), // ISO timestamp, UTC
  ccu: integer("ccu").notNull(),
});

export const dailyPeaksSteamCcu = sqliteTable("daily_peaks_steam_ccu", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  peakDate: text("peak_date").notNull(), // ISO date
  peakCcu: integer("peak_ccu").notNull(),
}, (t) => ({ uniq: uniqueIndex("daily_peaks_steam_ccu_unique").on(t.productId, t.peakDate) }));

export const igdbMediaCache = sqliteTable("igdb_media_cache", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().unique(),
  igdbId: integer("igdb_id"),
  summary: text("summary"),
  screenshots: text("screenshots"), // JSON string[] of IGDB image_ids
  videos: text("videos"),           // JSON string[] of YouTube video_ids
  updatedAt: text("updated_at").notNull(),
});

export const relatedGamesSteamHunters = sqliteTable("related_games_steamhunters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  relatedAppid: integer("related_appid").notNull(),
  relatedName: text("related_name").notNull(),
  headerImage: text("header_image"),
  trackedByHunters: integer("tracked_by_hunters"),
  computedAt: text("computed_at").notNull(),
}, (t) => ({ uniq: uniqueIndex("related_games_unique").on(t.productId, t.relatedAppid) }));
```

No new column needed on `products` for release status — reuse the EXACT predicate already live in
`server/leaderboards.ts` line ~227-228 for the Revenue board: `released = !!releaseDate && releaseDate <= today`.
This is the auto-enrollment rule: a title appears on the CCU board the first poll cycle after
`releaseDate <= today` becomes true, with zero manual step, mirroring the existing Wishlist/Revenue
auto-enrollment pattern already in production.

## 3. Ingestion: 60-minute CCU poll

New `server/ccu-poll.ts`, scheduled with the same wall-clock-interval pattern as `amazon-cron.ts` /
`ingestion.ts` (setInterval checked every 60s, fires once per 60-min slot — avoids drift, DST-safe).

Per tick:
1. `storage.getAllProducts().filter(p => p.steamAppId && p.releaseDate && p.releaseDate <= today)`.
2. For each, call Steam's public `ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=X` (no key required,
   same endpoint howmanyareplaying's `steamApi.js` uses for `fetchCurrentPlayers`).
3. Insert into `ccuSnapshotsSteam`. Upsert today's row in `dailyPeaksSteamCcu` with `GREATEST(existing, ccu)`.
4. Record `lastCcuPollAt` (new `app_settings` row, or reuse existing ops-status pattern) — this timestamp
   drives the countdown timer, exactly like `lastUpdatedAt` in howmanyareplaying.
5. Titles are ~20-40 max for Saber — no rate-limit concern, sequential fetch with a small inter-request
   sleep (150-300ms) is enough; no batching needed (unlike IGDB).

## 4. New leaderboard tab

`client/src/pages/leaderboards.tsx`: add a fourth `TabsTrigger value="ccu"` — "Saber Steam CCU Leaderboard" —
next to Wishlist / Revenue / Saber Amazon, same tab-switch pattern (`board` state / `handleTabChange`).

Board columns: Rank (within Saber's list), Title, header image, Current CCU, 24h peak, All-time peak,
Countdown timer (ported `CountdownTimer` component) in the board header driving a refetch on expiry.

## 5. Product detail page additions (click into a title)

All four additions land inside the existing per-product detail page/modal used by the other leaderboards
(`ChartDetailModal`/`product-detail` page — confirm exact host component during implementation):

a. **Peak CCU leaderboard/history view** — range filters `day/week/month/3m/6m/1y/all`, same semantics as
   `history.js`'s `/:appid` range handling (snapshots for `day`, daily-peak rollups beyond that).
b. **Peak-hours graph** — avg CCU by hour-of-day over trailing 30 days, ported from `history.js`'s
   `/:appid/hourly` (fixed 30-day window, no additional filter in the source — confirm if user wants
   the same fixed window or an additional range filter here too).
c. **IGDB media carousel + description** — port `GameMedia.jsx` (screenshot strip + trailer tile + lightbox)
   and render `igdbMediaCache.summary` as the descriptive text block. Backend: extend `server/igdb.ts` with
   `fetchIgdbMediaBySteamAppids()` using the same `external_game_source=1` batched query, adding
   `screenshots.image_id,videos.video_id,summary` to the field list. Runs on a slower cadence (daily is
   plenty — media/summary rarely change) alongside the existing `ingestIgdbHype()` step.
d. **"Top 5 Steam crossover games"** — port the 5-card grid design (non-clickable cards, header image,
   2-line-clamped name, "tracked by {N} hunters" caption) from `GameDetail.css` `.related-games__*` classes.
   Backend: a monthly precompute job hitting SteamHunters the same way howmanyareplaying's does, storing
   into `relatedGamesSteamHunters`, served via a new `/api/products/:id/related-games` endpoint.

## 6. Open questions before implementation starts

1. Countdown/refresh cadence confirmed at 60 minutes — matches request. OK to proceed as literal 60-min
   wall-clock interval (not tied to the existing 03:00 ET daily ingestion cron)?
2. For item 5a/5b, is reusing the existing `ChartDetailModal`/product-detail host acceptable, or does the
   user want a dedicated new page for CCU (like howmanyareplaying's standalone `/game/:appid`)?
3. For item 5d, howmanyareplaying's SteamHunters-based crossover computation is the real mechanism (not a
   simple heuristic). Confirm it's acceptable to replicate that same external dependency (SteamHunters) in
   SignalPulse, run on a monthly cadence, rather than inventing a lighter-weight substitute.
4. Confirm new tables (§2) and new hourly cron (§3) — both cross-cutting/architectural changes needing
   explicit sign-off per CLAUDE.md §10.

## 7. Delivery workflow (once confirmed)

Branch `feat/saber-ccu-leaderboard` → implement backend (schema, poll job, routes) → implement frontend
(tab, board, PDP additions) → `npm test` + `tsc --noEmit` → live curl verification of new endpoints →
desktop + mobile (≤400px) screenshots of the new tab and PDP additions → PR → user QA → squash-merge →
confirm via `GET /api/ingestion/status` `inFlight:false` before pushing → delete branch after merge.

## 8. QA notes (this segment)

- `tsc --noEmit -p .` clean and `npm test` 22/22 pass after all frontend changes (leaderboards tab,
  countdown timer, PDP section).
- CCU leaderboard tab and PDP section (KPI row, media carousel/empty-state, history chart w/ range
  chips, hourly-peak bar chart, related-games grid) verified locally against seeded `ccu_snapshots_steam`
  / `daily_peaks_steam_ccu` rows (temporarily inserted, then deleted — no seed data left in `data.db`,
  and product 1's `releaseDate` was restored to `2026-09-09` after the temporary edit used to satisfy the
  CCU-eligibility filter for the screenshot). Desktop screenshots look correct; hourly chart tested at a
  full 24-bar width and labels stay legible.
- The CCU history chart's fetch (`/signal/api/products/:id/ccu/history?range=...`) uses the same
  hardcoded `/signal/` prefix already used by the adjacent Sales-by-Country fetch on this page — both
  fail locally (dev server has no `/signal/` mount) and both are expected to work against prod, which is
  served under `/signal/`. This is pre-existing convention, not a regression.
- Mobile (390px) screenshot surfaced that the app's left sidebar does not collapse at narrow widths on
  ANY page — reproduced on the pre-existing Leaderboards page too, not something introduced by this
  feature. Flagged to the user as a separate, unrelated, app-wide issue rather than folded into this PR.
- Still outstanding: live curl verification against prod after deploy, branch/commit/PR/squash-merge with
  user sign-off.

