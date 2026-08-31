# Saber Publishing Partnerships Dashboard — Kickoff Spec

New app inside the Saber Intelligence Suite for the Publishing / BD / Marketing
teams to track value‑add partnership opportunities (revenue and marketing) on
every Saber title. This document is the source of truth for the initial build;
implementation lands in a follow‑up PR.

- **Suite slug:** `partnerships`
- **URL:** `http://104.236.239.46/partnerships/`
- **API prefix:** `/partnerships/api/`
- **Repo location:** `partnerships/` (mirrors `signalpulse/` and `triptracker/`)
- **Auth:** saber‑auth session (staged the same way SignalPulse rolled out —
  advisory `AUTH_MODE=both`, then flip to `saber`)
- **Deploy authority:** `sallisonhome/sentimentpulse` (this monorepo). Add
  `.github/workflows/partnerships-deploy.yml` mirroring `signalpulse-deploy.yml`.
- **Systemd unit:** `partnerships.service` (Node server on a dedicated local
  port), added to `deploy.sh` alongside `sentimentpulse signalpulse triptracker`.
- **Nginx:** add `/partnerships/` static + `/partnerships/api/` proxy blocks in
  `nginx/sentimentpulse.conf` and `deploy.sh`.
- **Launcher tile:** new `.app-card` on `launcher/index.html` linking to
  `/partnerships/` with a distinct accent color.

## Goal

A single source of truth leadership and working teams can hit to check the
status of every value‑add opportunity Saber is negotiating that brings in
revenue or marketing value **without Saber paying cash**.

## Data source of record

Titles are **not** created here. They are automatically populated from
SignalPulse: any product configured in SignalPulse appears in the Partnerships
dashboard with its **name, platforms, release date, and launch MSRP**
pre‑filled. Users then add opportunities against that title.

- Read from SignalPulse via the existing internal API (shared Postgres or
  `/signal/api/` — pick during implementation, prefer direct DB read for
  consistency, since both apps live in the same monorepo).
- If a title has no opportunities tracked, it does **not** surface in the main
  dashboard row/column view or the per‑product view.

## Main dashboard view (row/column)

Columns, in order:

1. **Title**
2. **Platforms**
3. **Release Date**
4. **Secured Revenue Partnerships** — count of Secured revenue deals
5. **Secured Revenue** — sum of $ across Secured revenue deals
6. **In Discussion Revenue Partnerships** — count in negotiation
7. **In Discussion Revenue Partnerships Value** — sum of $ across in‑discussion revenue deals
8. **Marketing Opportunities (# Secured)**
9. **Marketing Opportunities (# in Discussion)**
10. **# of Large Marketing Opportunities** — sum of those tagged Large
11. **Physical Retail Partner(s)** — partner name(s), or `TBD` if none set up
12. **Physical Retail MG ($)** — sum of MG dollars physical retail partners have put up

Clicking a title opens the **PDP view** described below.

## Per‑title PDP view

Follows the attached slide mockup: `pdp-quadrant-mockup.jpg`. It is a
professional, dark‑themed, 4‑quadrant layout consistent with the other suite
apps (SignalPulse / SentimentPulse / Trips PDPs).

**Header (top bar):**

- Title logo / name on the left, release year on the right.
- **Total Secured Partnership Revenue** displayed prominently — sum of $ across
  all Secured deals for the selected title.

**Above the quadrants — ring chart:**

- Donut/ring chart showing each category's share of Secured Partnership
  Revenue across the four buckets.
- Note in the legend: marketing opportunities typically contribute $0 in hard
  revenue but occasionally do; when they don't they don't consume ring share.

**4 quadrants (match mockup ordering exactly):**

| Position     | Quadrant                     |
| ------------ | ---------------------------- |
| Top‑left     | Physical Retail              |
| Top‑right    | Incremental Revenue          |
| Bottom‑left  | Physical Collectors Editions |
| Bottom‑right | Marketing Opportunities      |

Each quadrant renders the **Secured** opportunities for that bucket. Empty
quadrants show the mockup's placeholder copy (e.g. "Add retail notes here").

**Below the quadrants — In Discussion summary:**

- Bulleted / grouped list of any In Discussion opportunities being tracked,
  organized by the same four buckets.

## Opportunity model

Every opportunity carries:

- `state`: `In Negotiation` | `Secured`
- `category`: `Revenue` | `Marketing` (used for column rollups)
- `details`: free‑text notes
- Soft‑delete / flag when a discussion ends without a deal (do not hard delete;
  keep history for audit).

Opportunities are grouped into **three top‑level categories** with the
subcategories below. Users can add multiple entries within Incremental Revenue
items f–k.

### 1. Incremental Revenue

Subtypes — items f–k can have multiple entries per title:

a. Gamepass (XBOX)
b. PS+ (PlayStation)
c. Cloud — Luna
d. Cloud — GeForce Now
e. Cloud — Other
f. Hardware Bundle — Console → dropdown: PlayStation, XBOX, Switch 2
g. OEM — GPU Pack In
h. OEM Hardware Bundle — PC Hardware → dropdown: Lenovo, HP, Dell, ASUS, Other
   → if Other, open text field for details
i. Digital Preload → open text field for details
j. Digital Key Sales → dropdown: Genba, Fanatical, HeyBox (China),
   Green Man Gaming, Humble Store, Other → if Other, open text field
k. Physical Collector's Edition → captures vendor name, item(s) description,
   and work‑back schedule start date (auto‑computed as
   **release date − 12 months**). Also feeds the Physical Collectors Editions
   quadrant (see below for the item builder).

Input format:

- **Revenue category** → dollar amount ($)
- **Marketing category** → opportunity name, platform (PlayStation, XBOX,
  Nintendo, PC — Steam, PC — EGS, Other), date or date range, and value
  expressed in audience reach, impressions, **or** in‑kind marketing value ($).

### 2. Physical Retail

Multiple partners per title. `+ Add Partner` action.

Per partner:

- **Partner Name** — dropdown: Solutions 2 Go, NightHawk,
  U&I Entertainment / Cities, Plaion, Other → if Other, open text for name
- **Territories** — multi‑select: North America, Europe, Japan, Worldwide,
  Other → if Other, open a country picker dropdown
- **MG amount (USD)** — user input
- **% Royalties on Net Sales** — user input at setup

Rolls up into dashboard columns 11 and 12 (Partner name list + summed MG $).

### 3. Marketing Opportunities

Every marketing opportunity requires an **impact tier**: `Small`, `Medium`,
`Large`. `Large` count feeds dashboard column 10.

Subtypes:

- PlayStation State of Play
- XBOX Games Showcase
- Nintendo Direct
- Steam Next Fest
- Steam Demo Days
- Other → open text: opportunity name, who it is with, target date, and
  "Other" notes

## Physical Collectors Editions builder

Distinct from the Incremental Revenue "Physical Collector's Edition" flag —
this is the detailed builder that feeds the bottom‑left PDP quadrant.

Per title:

- **Vendor name**
- **MG ($)**
- **Work‑back start date** — auto = release date − 12 months (editable)
- **Items** — `+ Item` widget. Each item has:
  - Item name
  - Manufacturing cost ($) — `TBD` allowed when unknown
- **Estimated Cost of Collector's Edition Items** — auto sum of all item costs
  (excludes items marked TBD from the sum, but shows a "+ N TBD" indicator)

## Suite consistency requirements

- Match the existing dark theme, typography, cards, and spacing used across
  SignalPulse / SentimentPulse / Trips PDPs.
- Use the same launcher tile, header, and auth chrome as the other apps.
- Follow the same TypeScript + React + Vite + Node/Express stack as
  `signalpulse/` and `triptracker/`.
- Add a `partnerships` accent color to `launcher/index.html` alongside
  `sentiment`, `signal`, `trips`, `genres`, `gtm`.

## Follow‑up PRs

This kickoff PR delivers the spec and mockup only. Follow‑ups will land:

1. `partnerships/` scaffold (client + server + drizzle schema) mirroring
   `triptracker/`.
2. Nginx + systemd + deploy workflow wiring in `deploy.sh`,
   `nginx/sentimentpulse.conf`, and `.github/workflows/partnerships-deploy.yml`.
3. SignalPulse title sync (read‑only) + Partnerships schema + write API.
4. Dashboard row/column view + filters.
5. PDP quadrant view + ring chart + In Discussion summary.
6. saber‑auth integration in advisory `both` mode, then enforcement flip.
7. Launcher tile + suite chrome polish (design pass).

## Mockup

See `docs/partnerships/pdp-quadrant-mockup.jpg` — the reference layout for the
per‑title PDP quadrants (Hellraiser Revival, empty‑state placeholders).
