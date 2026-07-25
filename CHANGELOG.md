# SentimentPulse Changelog

A running log of what changed in SentimentPulse — new features, improvements, and fixes.

## July 25, 2026

- Fixed

  ### Changelog page now shows entry titles and descriptions, not just badges

  The changelog parser required `### Title` and body lines to be at the left margin, but the source file indents them under their bullet (standard markdown nesting). As a result the badges rendered but every entry looked like a bare pill with no title or description. Parser now tolerates leading whitespace on all lines and every entry back to July 17 renders properly.

- New

  ### Every new title (Saber game or competitor) now auto-runs a 90-day Steam Forum backfill on add

  When you add a new Saber title via POST /api/games or a competitor via the parent's settings card, the server now schedules a background job that walks up to 15 pages of Steam Forum listings for that game and pulls every post from the last 90 days. Reruns Steps 5–7 immediately so KPIs and daily summaries populate right away rather than waiting for the overnight cron. Also runs a one-time deep backfill for every currently active game via POST /api/ingest/backfill/steam_forums_all so ILL, Silent Hill: Townfall, and the rest fill in retroactively.

- Improved

  ### Steam Forum daily ingest now paginates

  Daily ingestion walks up to 10 forum listing pages per game (~150 threads visible instead of the previous 15) so busy titles don't lose posts when new active threads push older ones off page 1 within a day. Post dedup by external_id keeps re-scraping across days storage-free.

- Improved

  ### Steam Reviews and Steam Forum posts bypass the keyword relevance gate

  Posts on a game's own Steam store page are definitionally about that game — no franchise or dictionary noise is possible the way it is on cross-cutting Reddit/Bluesky feeds. Step 5 now auto-admits Steam Review + Steam Forum posts and skips the distinctive_keyword check for them. Reddit and Bluesky still run through the full gate + fuzzy layer.

- Fixed

  ### Charts on competitor sub-pages now render continuous x-axes on 7d/30d/90d/All

  Sparse titles like ILL (12 records across 90 days) previously rendered as a handful of disconnected floating points across a mostly-blank x-axis. Dashboard endpoint now zero-fills every day in the selected window for both Net Sentiment Trend and Post Volume by Source, so the charts look continuous even when active days are rare.

- Improved

  ### Competitor titles now appear in the game picker with a Competitor badge

  Competitor titles (ILL, Silent Hill: Townfall) now show in the top-of-app dropdown next to Saber parents, distinguished by a small uppercase "Competitor" badge. Selecting a competitor navigates directly to its dashboard. The same badge also shows on the picker trigger when a competitor is currently selected.

- Improved

  ### Child dashboards now show the game name, a Competitor · under ‹parent› badge, and a ← Back to ‹parent› breadcrumb

  When you land on a competitor's dashboard (via the game picker or the Post Volume by Title chart legend), the page now has a header at the top with the game's name, a small badge saying "Competitor · under ‹parent name›", and above it a ← breadcrumb link that navigates back to the parent's dashboard. Works for every parent/child relationship, not just Hellraiser's competitors.

- Fixed

  ### Post Volume by Title chart on parent dashboards now shows actual line data

  The chart rendered axes and a legend but no lines. Root cause was a data-shape mismatch — the endpoint returned `{day, counts: {game_id: n}}` and the chart wasn't flattening `counts` into top-level keys for recharts to find. Now Hellraiser's dashboard shows one line per title (parent + up to 4 competitors) with real daily mention totals.

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
