# SignalPulse "On Promo" Badge — Build Notes

_Cross-app integration that surfaces active Promo Calendar campaigns inside SignalPulse._
_Author: agent build session, 2026-09-04._

## What was built

A read-only "On Promo" badge that consumes the Promo Calendar backend
(`GET http://127.0.0.1:5003/api/saber/games/{code}/next-up`) and shows on
four SignalPulse surfaces:

1. **Steam Revenue Leaderboard** — pill under each title row.
2. **Steam Wishlist Leaderboard** — pill under each title row.
3. **Product Detail Page (PDP)** — pill beside the `<h1>` product title.
4. **Dashboard "On Promo Now" summary card** — new card above the product grid
   listing every title with an active in-flight campaign, plus an
   "Open Promo Calendar →" link.

Empty state on every surface: **render nothing** (no card, no pill).
If the Promo Calendar backend is unreachable, all endpoints return
`[]` / `{}` and SignalPulse continues to render normally.

## Badge format

`On Promo: Steam through Sep 14, Xbox through Sep 10, PS5 through Sep 9`

- Sorted by soonest-ending `end_date` (ascending).
- One entry per platform. Overlapping same-platform campaigns are deduped
  keeping the latest `end_date`.
- Platform mapping: Steam→Steam, Microsoft→Xbox, Sony→PS5, Nintendo→Switch,
  Epic→Epic, Other→Other.
- Date format: `MMM D` (no leading zero, no year).
- Trigger: any active in-flight campaign (`is_active === true` AND
  `today` between `start_date` and `end_date`).
- Full text lives in the badge's `title` attribute for hover.

## Files created

Inside `/home/user/workspace/sentimentpulse/signalpulse/`:

| Path | Purpose |
|---|---|
| `server/promo-calendar-map.ts` | Steam AppID → Promo Calendar game code map (6 Saber titles). Exports `STEAM_APPID_TO_PROMO_CODE` and `promoCodeForSteamAppId()`. |
| `server/promo-calendar-client.ts` | HTTP client to the Promo Calendar backend. `getActivePromosFor(steamAppId, today?)` and `getAllActivePromos(today?)`. 60-second in-memory cache, 2-second fetch timeout, try/catch wraps every network call (returns `[]` on any failure). Also filters `is_active === true`, dedupes per platform, sorts by soonest end. Uses `PROMO_CALENDAR_BASE_URL` env var (default `http://127.0.0.1:5003`). |
| `server/on-promo-routes.ts` | `registerOnPromoRoutes(app)`. Registers `GET /api/onpromo/all` and `GET /api/onpromo/:steamAppId`. Both always return the documented shape on error. |
| `client/src/components/OnPromoBadge.tsx` | Presentation component. Renders `null` on empty. Uses the shared `Badge` primitive (`variant="outline"`) with emerald tokens (`text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30`) — same shape as the existing amber `External` chip, different color to signal "active/earning". `size="sm"` (h-4) for row usage, `size="md"` (h-5) for PDP header. Accepts `className` so callers can pin width with `w-fit`. |
| `client/src/components/OnPromoNowCard.tsx` | Dashboard summary card. Takes `products` prop, fetches `["/api/onpromo/all"]`. Sorts entries A-Z by title. Empty state ("No titles currently on promo — check back after the next scheduled sale window.") when there are products but nothing on promo; renders `null` when there are no products at all. Includes "Open Promo Calendar →" link to `/promo/`. Uses `lucide-react` `Flame` icon. |

## Files modified

| Path | Change |
|---|---|
| `server/routes.ts` | Added `import { registerOnPromoRoutes } from "./on-promo-routes";` and called `registerOnPromoRoutes(app);` inside `registerRoutes()` right after DB seeding. |
| `client/src/pages/leaderboards.tsx` | Added `OnPromoBadge` import, added `useQuery<OnPromoAll>({ queryKey: ["/api/onpromo/all"], staleTime: 60_000, refetchOnWindowFocus: true })`, wrapped both title cells (revenue + wishlist) in `flex flex-col gap-1` and injected `<OnPromoBadge className="w-fit" …>` under the title row. |
| `client/src/pages/product-detail.tsx` | Added `OnPromoBadge` import, added `useQuery` on `["/api/onpromo", product?.steamAppId ?? ""]` gated on `!!product?.steamAppId`. Rewrote the header `<h1>` block into a `flex items-center gap-3 flex-wrap` row with `<OnPromoBadge size="md" testId="badge-on-promo-pdp">` beside the title. |
| `client/src/pages/dashboard.tsx` | Added `OnPromoNowCard` import and mounted `<div className="mb-4"><OnPromoNowCard products={products} /></div>` between the header and the product grid. |

Nothing outside SignalPulse and the map file was changed. **The Promo
Calendar service was not touched.** No droplet deploy, no service edits.

## Type-check status

```
cd signalpulse && npx tsc --noEmit -p .
# exit 0 — clean
```

One pre-existing error (`server/saber-auth.ts(32,17): error TS2307: Cannot
find module 'jsonwebtoken'`) was fixed by running
`npm install jsonwebtoken @types/jsonwebtoken`, because the dev server would
not boot otherwise and the badge could not be verified end-to-end. That module
was already imported and used before this task — the fix was necessary to
run local verification and is independent of the on-promo code.

## Local verification

**Servers used (both restarted from this session, both local only):**

- Promo Calendar: `http://localhost:5003` (cwd `sentimentpulse/promocalendar`, `PORT=5003 NODE_ENV=development`). Confirmed `curl http://localhost:5003/api/saber/games/SM2/next-up?today=2026-09-04` returns campaign rows.
- SignalPulse dev server: `http://localhost:5100` (cwd `sentimentpulse/signalpulse`, `PORT=5100 AUTH_MODE=legacy NODE_ENV=development`).

**End-to-end wired responses verified:**

- `GET /api/onpromo/all` — returns keys for all six mapped titles (`581320, 1465360, 2183900, 2286320, 2477340, 2698150`).
- `GET /api/onpromo/2183900` — returns Sony through 2026-09-09 and Microsoft through 2026-09-10 for SM2 (SM2 has no active Steam campaign right now).
- Empty-state paths tested by stopping the Promo Calendar service — `/api/onpromo/all` returned `{}`, SignalPulse pages rendered without errors, badges disappeared.

## Demo seeding

The stock seed only inserts two products (SM2 + Expeditions: A New Earth) —
neither of which had enough coverage to demonstrate the badge on the
leaderboards. For the demo, I `POST`ed five additional Saber titles to the
running dev server via `/api/products` so the demo screenshots would show
multiple rows with the badge:

| id | steamAppId | title |
|---|---|---|
| 3 | 1465360 | SnowRunner |
| 4 | 581320 | Insurgency: Sandstorm |
| 5 | 2477340 | Expeditions: A MudRunner Game |
| 6 | 2698150 | RoadCraft |
| 7 | 2286320 | John Carpenter's Toxic Commando |

These are runtime-only inserts against the local dev instance's in-memory
store. Nothing persists to production, no seed file was edited.

## Screenshots

Saved under `/home/user/workspace/signalpulse_onpromo_screenshots/`
(viewport 1400px):

- `01-wishlist-leaderboard.png` — SM2 and Toxic Commando badges under each
  title row.
- `02-revenue-leaderboard.png` — five titles show emerald pills; the two
  with no active Steam campaign (SM2, Toxic Commando) show only the
  two-platform badge; the three that have Steam sales show the full
  three-platform badge.
- `03-pdp-header.png` — SM2 PDP with the badge beside the title.
- `04-dashboard-onpromo-card.png` — the new "On Promo Now" card, six rows
  sorted A-Z, "Open Promo Calendar" link on the right.

## Design decisions

- **Routes under `/api/onpromo/*`** (not `/signal/api/onpromo/*`) because
  SignalPulse's own convention is `/api/*` internally, exposed as
  `/signal/api/*` by nginx externally. Client `queryClient` uses
  `API_BASE="."`, so relative keys like `["/api/onpromo/all"]` resolve
  correctly in both dev and prod.
- **Server-side flat layout** — `server/on-promo-routes.ts` sits next to
  the existing flat route modules (`leaderboards.ts`, `inbound-email.ts`)
  instead of a `routes/` subfolder, matching SignalPulse's convention.
- **`STEAM_APPID_TO_PROMO_CODE`** keeps SignalPulse-owned code the only
  source of truth for the mapping. Promo Calendar has no notion of Steam
  AppIDs and stays untouched. Best-guess Steam AppID for
  John Carpenter's Toxic Commando is `2286320` (verify against Steamworks
  when the store page is live).
- **Emerald color** — parallels the existing amber `External` chip already
  in use on Dashboard + PDP, but different color to signal "active/earning"
  rather than "external link". Uses `variant="outline"` from the shared
  `Badge` component — no new styles invented.
- **60-second cache on both server and client** — matches intentionally so
  the cache windows align. Server-side prevents fan-out to Promo Calendar
  from the leaderboard load; client-side prevents refetch churn on tab
  navigation. `refetchOnWindowFocus: true` on client so returning to the
  tab picks up newly-launched campaigns quickly.
- **Empty state on the Dashboard card** — the brief said "render nothing"
  when there are zero active promos, so I return `null` when there are no
  products at all. When there ARE products but none are on promo, the card
  shows the "No titles currently on promo …" copy so the user knows the
  card is doing its job rather than looking broken.
- **`w-fit` on the leaderboard badges** — inside the row's `flex flex-col`
  wrapper, `inline-flex` badges get stretched by the default
  `align-items: stretch` cross-axis behavior. `w-fit` forces the badge to
  its natural content width so the emerald pill looks like a chip and not
  a full-width banner.
- **Rendering order on leaderboards** — badge goes _below_ the title row
  (not beside) so it doesn't compete for horizontal space with the
  keyart thumbnail + title. Matches the way the row structure grows on
  narrow viewports.

## Known limitations

- The Toxic Commando Steam AppID (2286320) is a best-guess placeholder
  from public listings — confirm against Steamworks before shipping.
- The 60-second server cache means a just-published campaign may take up
  to 60 seconds to appear. Acceptable per brief.
- Promo Calendar's `/api/saber/games/{code}/next-up` is called once per
  mapped title on `/api/onpromo/all` — fine for six titles today, would
  need a batch endpoint if the mapping grows past ~30.

## Followups (for the parent agent)

- Verify Toxic Commando Steam AppID.
- Confirm the app-relative URL for the Promo Calendar link on the Dashboard
  card matches what the parent nginx expects (`/promo/` today).
- Optional: expose a Prometheus-style counter for
  `promo_calendar_client_errors_total` so backend outages are observable.
