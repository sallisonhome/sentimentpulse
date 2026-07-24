# SentimentPulse Changelog

A running log of what changed in SentimentPulse — new features, improvements, and fixes.

## July 24, 2026

- Improved

  ### Clickable changelog in the footer

  Added a Changelog link to the app footer so you can see what's shipped over time without leaving SentimentPulse. Same pattern as howmanyareplaying.com. This is the first entry.

## July 23, 2026

- Improved

  ### Bus Bound reddit sources

  Added 29 reddit sources to Bus Bound (Steam App ID 2095420) covering the Bus Simulator lineage, vehicle sim, transit/urbanism, cozy/management sim, and broad-gaming subs. Ingestion picks new posts up forward-only from the moment the sources were saved.

## July 22, 2026

- Fixed

  ### Steam Web API key save no longer 404s

  The Settings page was calling `/api/settings/…` at the root instead of `/signal/api/settings/…`, hitting nginx's no-location wall and returning HTTP 404 for every save attempt. Three call sites (Steam key save, delete-product auth, initial password gate) now use relative paths so they honor the `/signal/` base. In parallel, the client's error toast now surfaces the real HTTP status + response body instead of a generic "Failed to save setting" — future save issues will be diagnosable at a glance.

- Improved

  ### Steam wishlist ingestion runs against the real Steamworks Partner API

  Previous ingestion called `ISteamUserStats/GetAppWishlistReporting/v1/` which does not exist on Steam's servers and returned HTTP 404 for every Saber-published title. Rewritten to hit `IPartnerFinancialsService/GetAppWishlistReporting/v001/` (the real endpoint), which requires a Publisher Web API key with Financial permissions and returns daily wishlist deltas (adds, deletes, purchases, gifts) plus per-country and per-language breakdowns. Also added a `POST /api/steam/backfill/:productId` endpoint that walks from a product's `app_min_date` to yesterday at 1 request/sec so full historical wishlist series can be recovered on demand.

## July 20, 2026

- New

  ### Download Trip Report PDF from every event

  Every Trip Tracker event with at least one ingested trip report now shows a "Download Trip Report PDF" button in the Executive Summary card. It generates a 13+ page agency-quality board memo — Saber-branded cover, executive summary, opportunities and issues as numbered cards, big ideas as amber bullets, action items as a table, and a per-meeting summary appendix (2-column, sentiment dots, topic tags). Auto-scales to the meeting count.
