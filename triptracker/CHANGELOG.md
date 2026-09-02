# Trip Tracker Changelog

A running log of what changed in Trip Tracker — the trip, show, and partner meeting report system for Saber's business development team.

## September 1, 2026

- Improved

  ### Publishing Partnerships added to sidebar navigation

  Trip Tracker now links to the Publishing Partnerships sub-app from its sidebar, matching every other suite app.

## August 31, 2026

- Fixed

  ### Download Trip Report PDF stuck in "Unconfirmed *.crdownload"

  Chrome's Safe Browsing was intercepting the fetch+blob download because the bare-IP HTTP host wasn't trusted. Switched the client from fetch+blob to a direct anchor navigation, which Chrome accepts. PDFs now download cleanly on the first click.

## July 20, 2026

- New

  ### Download Trip Report PDF

  One-click export of any trip report as a formatted PDF suitable for forwarding to partners, executives, or archive.

## June 24, 2026

- New

  ### Confirm-or-Omit citation grounding + self-criticism on exec summaries

  Every claim in the executive-summary paragraph now has to trace back to a specific note or citation; the LLM re-reads its own draft and drops sentences it can't cite. Reduces hallucinated partner names, quotes, and outcomes.

## April 9, 2026

- New

  ### Trip Tracker launched

  Third app in the Saber Intelligence Suite. PostgreSQL backend, cross-navigation with SentimentPulse and SignalPulse, shared theme, launcher card. Pull trip notes into a structured report with per-partner summaries, next actions, and export-ready formatting. Renamed to "Saber Trip/Show & Partner Meeting Report Tracker" everywhere shortly after launch to make the scope clear.

- Fixed

  ### pdf-parse ESM bundling issues

  A stack of ship-day fixes: pdf-parse added to esbuild allowlist, ESM namespace import with default fallback, isDummy flag added so demo events render with a red banner, and downgrade to pdf-parse v1 which bundles cleanly. Trip API routes prefixed with `/trips` so nginx correctly routes to port 5001.
