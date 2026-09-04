# Promo Calendar frontend — build notes

Seventh app in the Saber Intelligence Suite. Route base is `/` (updated
from the earlier `/partnerships/` value in `vite.config.ts`). Backend
and Vite are co-hosted on port 5003 by `server/index.ts`.

Server smoke test:
```
cd /home/user/workspace/sentimentpulse/promocalendar
PROMO_SKIP_AUTH=1 npx tsx server/index.ts
curl http://localhost:5003/api/health
```

Production build: `npm run build` → `dist/public/` (SPA bundle) and
`dist/index.cjs` (server). Run with
`PROMO_SKIP_AUTH=1 NODE_ENV=production node dist/index.cjs`.

Type-check gate: `npx tsc --noEmit -p .` — **zero errors**.
Test gate: `npm test` — **6/6 parser tests pass**.

## Single calendar only

Single calendar only — the two-calendar switcher was removed per user
request on 2026-09-04. Backend `/api/{cal}/*` routes still accept
`saber_focus` (unused); UI never sends it.

Concretely:
- `client/src/lib/api.ts` exports `CALENDAR = "saber" as const`. Every
  endpoint helper hardcodes that value; there is no `{calendar}` parameter.
- `client/src/components/Shell.tsx` renders the topbar with breadcrumbs +
  date + user avatar only — no calendar switcher pill buttons.
- Sidebar app label is "Promo Calendar" (singular).
- Breadcrumbs are `Promo Calendar › <view>` (no "Saber Promo Calendar"
  prefix, no per-calendar segment).
- `client/src/pages/SettingsPage.tsx` shows only the Saber upload/history
  section. No `saber_focus` scaffolding.

Nothing in the UI persists a "selected calendar" in localStorage — the
only persisted per-surface state is the view toggle (see `usePersistedState`).

## Routes (wouter hash router)

| Path | Component | Notes |
|------|-----------|-------|
| `/` | `pages/CalendarPage` | Landing. Next-Up strip + Next-Up-Multi strip + Grid/Timeline toggle. |
| `/titles` | `pages/TitlesPage` | Directory grid, 6 games. |
| `/titles/:code` | `pages/TitleDetailPage` | Hero KPIs · next-up · platform filter · Cards/Table toggle. |
| `/platforms` | `pages/PlatformsPage#PlatformsIndex` | 3 platform tiles with next-beat preview. |
| `/platforms/:platform` | `pages/PlatformsPage#PlatformDetail` | Hero KPIs · next-6 · master table. |
| `/events` | `pages/EventsPage` | List (grouped by month) or Table view · when + platform filter bar. |
| `/events/:key` | `pages/EventDetailPage` | Sale-window progress + participating titles grid with discount ranges. |
| `/analytics` | `pages/AnalyticsPage` | KPI strip + live pills + platform/title breakdown + master 500-row table. |
| `/settings` | `pages/SettingsPage` | Saber-only upload UI + upload history + rollback. Allowlist-gated. |

Server-anchored "today" comes from `?today=YYYY-MM-DD` on either the
top-level query string OR inside the hash query. Example testing URL:
`http://localhost:5003/?today=2026-09-04#/`.

## Components

`client/src/components/`:
- `Shell.tsx` — sidebar (nav + counts + data-source footer) + topbar (crumbs
  + today + avatar). No calendar switcher.
- `chips.tsx` — `PlatformChip`, `StatusChip`, `GameChip`, base `Chip`.
- `BeatCard.tsx` — `BeatCard` (single-title) + `MultiBeatCard` (multi-title).
- `EventCard.tsx` — clickable event card for the events list.
- `MonthGrid.tsx` — Sunday-first month calendar with day-chips and a
  `DayDrawer` side panel that fetches per-day event details on click.
- `Gantt.tsx` — portfolio timeline. Auto-fits the date window to the
  visible events + a 1-week pad on either side, month + week ticks,
  today line, per-title bar rows with collision-free row packing.
- `misc.tsx` — `Skeleton`, `ErrorBanner`, `EmptyNoUpload`, `SegToggle`,
  `Section`.

`client/src/lib/`:
- `api.ts` — typed fetch client, all endpoints hardcoded to `saber`.
- `format.ts` — date/duration/percent/byte formatters + `platCls`.
- `today.ts` — reads `?today=YYYY-MM-DD` from hash or top-level query.
- `hooks.ts` — `useAsync` (with `reload` + cancel) and `usePersistedState`
  for the localStorage-backed view toggles.

## Dark + light mode

Handled by CSS `@media (prefers-color-scheme: light)` in
`client/src/styles/tokens.css`. The tokens file has two definitions —
the original at the bottom of the file and a duplicate near the top that
was added during the build session. Both agree on the primary swap
(neutral surfaces + darker text) and are safe to keep, though a future
tidy-up should consolidate them into one block.

Verified visually: light-mode screenshots (`promocal_shots/light_*.jpeg`)
show a light-gray background (`rgb(245,246,250)`) with dark text
(`rgb(26,28,34)`); dark-mode screenshots use the deep-navy background
(`#0a0c10`).

## View toggles

Each toggle is persisted in `localStorage` under its own key:
- `promocal.view.calendar` — Grid / Timeline
- `promocal.view.title` — Cards / Table (per-title PDP)
- `promocal.view.events` — List / Table

## Known gaps / deviations

- **Gantt lanes fan out per-event.** The `/events?when=…` payload does not
  say which games participate in each event, so the timeline renders each
  event bar in every game lane (a valid over-approximation for planning
  purposes; the per-event participation is available on
  `/events/:key`). If we want per-lane accuracy we should extend the
  events summary to include `games: string[]`.
- **Analytics platform breakdown counts platform slots per campaign**,
  which matches the campaigns index (there is no platform-per-event
  fan-out for events themselves).
- **Master analytics table caps at 500 rows** with a note. Full detail
  is available through the per-title PDP.
- **Wouter's `useHashLocation` strips top-level search from the returned
  path**, so both the URL `#/…` (recommended) and `/?today=YYYY-MM-DD#/…`
  (for anchored today) work. Do NOT put `?today=` inside the hash after
  a route — `#/events?today=…` will make `Route path="/events"` miss.
  See `today.ts` for the fallback logic (it reads either location).
- **No routing tests** — only backend parser tests exist. Frontend QA is
  screenshot-driven (see `promocal_shots/`).
- Server-log prefix `[partnerships]` in `[YYYY-…] [partnerships] promocalendar listening on :5003`
  is inherited from the scaffold and left unchanged.

## Screenshots (verified this session)

Stored in `/home/user/workspace/promocal_shots/`, both `dark_*` and
`light_*` variants:
- `01_calendar_home` — `/`
- `02_events` — `/events`
- `03_title_sm2` — `/titles/SM2`
- `04_event_first_live` — `/events/57b11514d6f677df` (Gamescom, live)
- `05_analytics` — `/analytics`
- `06_settings` — `/settings`

All were captured with `?today=2026-09-04` so live/upcoming states are
stable.
