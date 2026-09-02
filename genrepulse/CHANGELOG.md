# Genre Pulse Changelog

A running log of what changed in Genre Pulse — the genre-level PC market intelligence surface mirroring howmanyareplaying.com.

## May 19, 2026

- New

  ### Platform Mix widget

  Port of the Platform Mix widget from howmanyareplaying.com. Shows PC vs. console platform-share breakdowns by genre with the same source data driving hmap.

## May 15, 2026

- New

  ### Added to launcher + all suite sidebars

  Genre Pulse now shows up as a full card on the launcher home page and cross-links from every other suite app's sidebar.

- Improved

  ### Median Units Sold + Median Est. Gross Sales

  Mirrored the hmap change from average to median for both units sold and estimated gross sales. Median is far more robust for genre analysis where a handful of megahits skew averages.

## May 4, 2026

- New

  ### Genre Pulse launched

  Fourth app in the Saber Intelligence Suite. Mirrors howmanyareplaying.com via nginx proxy so genre-level PC market intelligence lives right alongside SentimentPulse, SignalPulse, and Trip Tracker. Data source: hmap's public API. No auth pass-through required — the widget renders whatever hmap exposes.
