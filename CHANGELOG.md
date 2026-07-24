# SentimentPulse Changelog

A running log of what changed in SentimentPulse — new features, improvements, and fixes.

## July 24, 2026

- Improved

  ### Relevance gate now blocks off-topic posts before sentiment classification

  The keyword-based relevance filter used to run in the topic-extraction step, after posts had already been sentiment-classified and counted toward dashboard aggregates. It now runs earlier, in the sentiment-classification step, so off-topic Reddit posts (movie/IP references, unrelated games, generic chatter) never get a sentiment record at all. Games with no keywords configured are now excluded from classification rather than silently passed through — see the keyword auto-population and startup-warning entries below.

- Improved

  ### Layer 2 fuzzy match tolerates typos and misspellings without letting noise through

  Added a second matching pass that catches common misspellings and typos of multi-word keywords (e.g. "Bus Buond" for "Bus Bound") using a small edit-distance check, but only as a fallback when the exact keyword match finds nothing. Single-word keywords, short phrases, and any post that already has an exact match belonging to a different game are excluded from fuzzy matching to keep the false-positive rate low. Can be disabled via the `RELEVANCE_FUZZY_LAYER_ENABLED` setting.

- Improved

  ### Every active game now has distinctive keywords configured; new games auto-populate on creation

  All active games now have a reviewed list of distinctive keywords used by the relevance gate. Creating a new game via the API no longer leaves the keyword list empty by default — a heuristic generator produces a starter set from the game's title, and the server logs a warning if fewer than 3 keywords come out so it can be reviewed manually. A startup check also warns if any active game is still missing keywords.

- Fixed

  ### Backfill purged July's off-topic reddit sentiment records so the July monthly summary reflects only real game discussion

  Re-ran the new relevance gate against every Reddit-sourced sentiment record from July 1–24, 2026 and removed the ones that were never actually about the focal game. The underlying posts are kept for audit purposes; only the sentiment records tied to off-topic posts were deleted. The July monthly summary regenerates from the cleaned-up data on its next scheduled run.

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
