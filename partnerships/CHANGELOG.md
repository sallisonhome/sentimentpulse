# Publishing Partnerships Changelog

A running log of what changed in Publishing Partnerships — the internal surface for tracking non-cash publishing opportunities by title.

## September 1, 2026

- Improved

  ### Publishing Partnerships added to launcher + every sub-app sidebar

  New app link surfaces on the suite launcher home page and in the left sidebar of SentimentPulse, SignalPulse, Trip Tracker, GTM Studio, and Genre Pulse.

## August 31, 2026

- New

  ### Publishing Partnerships launched

  Sixth app in the Saber Intelligence Suite. Full-stack: Express backend + Vite/React frontend + Drizzle ORM. Tracks non-cash publishing opportunities per title — first-party feature slots, storefront placements, discovery quests, cross-promo trades — with an authoritative status per opportunity and per-title timelines.

- Fixed

  ### nginx `/partnerships/assets/` routing beats regex JS cache rules

  Used `^~` prefix to make the partnerships-scoped rule beat generic regex cache rules that were 404ing the app's JS bundle.

- Fixed

  ### `process.cwd()` for distDir under CJS bundle

  The distDir path resolution was breaking under the deploy's CJS bundle. Switched to `process.cwd()` for portability.

- Improved

  ### Deploy wiring — nginx + systemd + workflow

  Full deploy path plumbed: dedicated nginx block, systemd unit, GitHub Actions workflow. Ready for regular incremental deploys alongside the rest of the suite.
