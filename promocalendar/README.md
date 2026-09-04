# Saber Publishing Partnerships

Sub-app of the Saber Intelligence Suite. Tracks value-add revenue and marketing
partnerships across every Saber title.

## Ports & Paths

- **Port:** 5002 (SignalPulse 5000, Trip Tracker 5001, Partnerships 5002)
- **Public URL:** `http://104.236.239.46/partnerships/`
- **API prefix:** `/partnerships/api/`
- **Data:** SQLite at `/opt/sentimentpulse/partnerships/data.db`
- **SignalPulse source of titles:** read-only handle on
  `/opt/sentimentpulse/signalpulse/data.db` (override with `SIGNALPULSE_DB_PATH`)

## Full spec

See [docs/partnerships/README.md](../docs/partnerships/README.md).

## Local dev

```bash
cd partnerships
npm install
# Point at a local SignalPulse DB (or leave unset — the app degrades to
# an empty title list and stays green)
export SIGNALPULSE_DB_PATH=../signalpulse/data.db
npx tsx server/index.ts
# → http://127.0.0.1:5002/
```

For a production-mode build + serve:

```bash
npm run build
PORT=5002 NODE_ENV=production node dist/index.cjs
```

## Endpoints

Read:

- `GET /api/health`
- `GET /api/titles` — SignalPulse products projected
- `GET /api/titles/:id`
- `GET /api/dashboard` — 12-column rollup, hides titles with no opportunities
- `GET /api/pdp/:productId` — header total, ring chart, 4 quadrants, In Discussion summary

Write:

- `POST/PATCH/DELETE /api/opportunities[/:id]` — Incremental, CE, Marketing (soft-delete via DELETE with `{reason}`)
- `POST/PATCH/DELETE /api/retail-partners[/:id]` — Physical Retail Partners
- `POST /api/ce-items` / `DELETE /api/ce-items/:id` — Items inside a Collector's Edition

All writes validated with drizzle-zod. Every create / update / soft-delete is
mirrored into `opportunity_audit_log`.

## Schema

- `opportunities` — one row per opportunity, `bucket` in {IncrementalRevenue, PhysicalRetail, MarketingOpportunity, CollectorsEdition}
- `physical_retail_partners` — one row per partner per title
- `collectors_edition_items` — child rows inside a CE opportunity (+Item widget)
- `opportunity_audit_log` — append-only audit trail

See `shared/schema.ts` for the full source of truth.

## Design

Dark chrome matches the launcher palette (`#0a0c10` bg, `#141720` surface).
Accent is teal (`#14b8a6`), distinct from every existing sub-app.

PDP quadrants use a deep-navy panel matching the Hellraiser Revival mockup at
`docs/partnerships/pdp-quadrant-mockup.jpg`, with the quadrant order locked to
the mockup: Physical Retail (top-left), Incremental Revenue (top-right),
Physical Collectors Editions (bottom-left), Marketing Opportunities (bottom-right).

## Auth

Currently unauthenticated. Saber auth wiring lands in a separate PR that flips
the whole suite together (mirrors the SignalPulse/TripTracker rollout).
