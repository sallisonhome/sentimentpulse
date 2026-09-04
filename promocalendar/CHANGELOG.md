# Saber Promo Calendars Changelog

A running log of what changed in Saber Promo Calendars — the promotional-sales
calendar sub-app in the Saber Intelligence Suite.

## September 4, 2026

- New

  ### Saber Promo Calendars launched (backend + Events + Next Up scaffolding)

  Seventh app in the suite. Two independent calendars — **Saber Promo Calendar** and
  **Saber × Focus Promo Calendar** — each fed by an Excel workbook where each tab is
  one game per year (e.g. `SM2 2026`, `Snow 2024`), split into platform sections
  (STEAM / MICROSOFT / SONY) via merged banner rows.

  The parser handles:
  - Merged banner rows for platform sections
  - ExcelJS formula-cell unwrapping (`{formula, result, sharedType}` → value)
  - European price strings (`"$29,99"` → 29.99)
  - Discount stored as decimal or percent (`0.6` and `60` both → 0.6)
  - Silent skip of `TBC`/`TBD` date rows and content-without-program reference lists
  - Header detection tolerant of 2024's extra `Partner` column
  - Deterministic collapse of many SKU rows per (game, platform, program, dates)
    into one Campaign row + N SkuLine rows

  Real-data numbers from the initial Saber sample: **1,013 campaigns / 4,320 SKUs /
  16 sheets processed / 18 warnings** (all real ops-side data quirks).

- New

  ### Events tab — multi-title promos as first-class objects

  Any (program, platform, start, end) tuple spanning 2+ titles is exposed as an
  Event with a stable SHA1-derived `event_key` URL. Browse by `?when=upcoming|live|past|all`,
  filter by platform, drill into per-event detail with per-title campaign deep links.
  The initial Saber sample surfaces **193 multi-title events** — Summer Sales, Autumn
  Sales, Black Friday, Publisher Sales, Gamescom, Tokyo Game Show, Deals with Gold,
  Publisher Spotlight Series, Ultimate Games Sale, Countdown Sale, etc.

- New

  ### Next Up strips — server-anchored, self-updating

  Five endpoints all pivot on server-side `today`, so passed beats drop off
  automatically without any cron:
  - `GET /api/{cal}/next-up` — top 3 across whole calendar
  - `GET /api/{cal}/next-up/multi-title` — top 3 multi-title events
  - `GET /api/{cal}/platforms/{p}/next-up` — per-platform view
  - `GET /api/{cal}/games/{code}/next-up` — per-title, across ALL platforms
  - Every endpoint accepts `?today=YYYY-MM-DD` for demo/testing

  Order: in-flight beats first (by end date), then upcoming (by start date).
  In-flight beats carry `is_active: true` for LIVE badging.

- New

  ### Full-replace ingest with 10-upload history + rollback

  Every upload becomes an `uploads` row with the original .xlsx blob stored
  base64 alongside. On new ingest, the previous active upload is deactivated,
  campaigns/sku_lines are wiped and repopulated, and older uploads beyond the
  last 10 are pruned. Rollback to any earlier upload re-parses its stored blob
  and re-activates it.

- New

  ### Uploader allowlist gate

  Uploads (`POST /api/{cal}/upload`) and rollbacks (`POST /api/uploads/{id}/rollback`)
  require the caller's suite email — extracted from the `X-Saber-User` header the
  saber-auth wrapper sets — to be on the uploader allowlist in `server/auth.ts`.
  Reads are open to any authenticated suite user. `GET /api/me` returns
  `{ email, can_upload }` for the frontend to hide/show the Settings > Upload
  button. Configurable at runtime via `PROMO_ADMIN_UPLOADER_EMAILS` env override.

- New

  ### Regression suite: 6 tests covering real-sheet ingest

  `server/parser.test.ts` runs against the committed
  `scripts/fixtures/Promo-Schedule-Saber.xlsx`, asserting: >900 campaigns,
  >4000 SKUs, <25 warnings, platform banners split correctly, SKU prices
  populated for >80% of rows (unwrapped from formula cells), >100 multi-title
  clusters exist, and game display labels resolve. Runs via `npm test`.
