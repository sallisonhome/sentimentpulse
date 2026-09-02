# GTM Studio Changelog

A running log of what changed in GTM Studio — the AI-assisted go-to-market deck builder for Saber and its portfolio titles.

## September 1, 2026

- Improved

  ### Publishing Partnerships added to sidebar navigation

  GTM Studio now links to the Publishing Partnerships sub-app from its sidebar.

## July 18, 2026

- New

  ### GTM v7.3 polish pass

  Slide 1 subtitle refreshed. Slide 4 no longer truncates on long content. Slide 6 KPIs run wider with real headers. Slide 3 USPs and Slide 4 Challenges dropped the wedge column and now go full-width. Curved arc-text ring labels + global title auto-shrink for better fit across long game names.

- Improved

  ### GTM reach slide accepts comma-heavy free-text channels + caps at 4

  Was tripping on over-eager comma splits. Now handles "PR + Influencers + Discord (weekly cadence)" as a single entry and caps at 4 channels per cohort. Max also bumped 4 → 7 across the reach slide overall.

- Fixed

  ### GTM wizard Step 4 crash + Step 1 genreCustom ReferenceError

  Step 4 was crashing on empty platform lists. Step 1 threw on the genreCustom scope path. Both fixed and TS strict build gate enabled to catch future regressions at compile time.

- Improved

  ### GTM Step 2: genre dropdown to prevent syntax errors + custom fallback

  Free-text genre was letting typos and syntax errors propagate into the LLM prompts. Dropdown with a `Custom…` fallback fixes both cases.

- Fixed

  ### Preview uses REAL PNG filenames from backend, not synthesized ones

  Preview was building filenames client-side and 404ing on mismatches. Backend now returns the canonical filenames.

- Fixed

  ### Preview: 500 on empty platforms + surface real errors

  Empty-platforms path was silently 500ing. Real errors now surface to the UI so ops can debug generation failures.

- Fixed

  ### Genre Pulse "pull defaults" failing with 301 + 404

  Cross-app pull from Genre Pulse was hitting a redirect chain that dropped the request. Fixed the URL to hit the canonical endpoint.

## July 15, 2026

- New

  ### GTM v6.0 — 6-slide pack + full design pass on slides 2-6

  Reordered slide sequence. Design pass across every slide 2-6 for typography, spacing, and consistent visual language. Description-Razors slide word-cap fixed so 20-word razors don't overflow.

- Fixed

  ### `/example` endpoint numeric sort so slide 10-12 come after 9

  Was string-sorting: `10` came before `9`. Now numeric.

- Fixed

  ### gtmstudio.service crash on Sonar client

  Inlined the Sonar client into `translate.py` so the service doesn't crash on cold start.

- Fixed

  ### Translate endpoint 500 on legacy decks missing new fields

  Legacy decks predating the v7 fields were crashing the translate endpoint. Handler now populates safe defaults for missing fields.

## May 27, 2026

- New

  ### GTM in-app deck viewer

  Preview and share decks inside GTM Studio without downloading. Includes zoom, per-slide anchor links, and shareable URLs.

## May 15, 2026

- New

  ### GTM Studio launched

  Fifth app in the Saber Intelligence Suite. Full stack: renderer package + FastAPI backend with preview + library endpoints, React + Vite + Tailwind frontend, nginx routing, launcher card, and cross-app sidebars in every existing suite app. Admin auth, delete/restore/purge/audit/password mechanics, and rate limiting all shipping in the initial pass. Redesigned home (inputs/outputs section), polished hero copy, and the first version of the Example viewer.
