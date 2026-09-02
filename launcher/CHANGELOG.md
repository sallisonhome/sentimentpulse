# Saber Intelligence Suite Launcher Changelog

A running log of what changed in the launcher — the home page for the Saber Intelligence Suite.

## September 1, 2026

- Improved

  ### Publishing Partnerships card added to the launcher

  New sixth app card. Also links from every sub-app's sidebar so users don't have to bounce through the launcher to reach it.

## August 31, 2026

- New

  ### Publishing Partnerships deploy wiring shipped

  Full deploy path (nginx + systemd + GitHub Actions workflow) so the new app is ready for regular incremental deploys alongside the rest of the suite.

## August 13, 2026

- New

  ### Saber-auth cutover for the launcher

  Launcher now authenticates via the shared saber-auth service. Grace-week overlap with the legacy flow ran through Aug 20. Copy updated to "Your Saber Suite Account & Password" and the saber-auth cookie-secure patch applied via workflow.

## July 27, 2026

- Fixed

  ### Stale-browser-cache after deploys

  Touched `index.html` on every deploy and installed an nginx no-cache header for the launcher shell. Users no longer see yesterday's launcher after today's deploy.

## May 15, 2026

- Improved

  ### GTM Studio added as a 5th card + cross-app sidebars

  GTM Studio card on the launcher. Every existing sub-app got a sidebar link to GTM Studio in the same pass.

## May 4, 2026

- Improved

  ### Genre Pulse added as a 4th card

  Genre Pulse card on the launcher, mirroring howmanyareplaying.com via nginx proxy.

## April 9, 2026

- Improved

  ### Trip Tracker card added, layout polished

  Trip Tracker joins as the 3rd card. Cards now have equal heights, wider layout, shortened Trip Tracker title, left-aligned text, and a hover glow. Dark-mode preference persists across apps via a shared localStorage key.

## April 8, 2026

- New

  ### Saber Intelligence Suite launched

  First shipped version of the unified launcher, combining SentimentPulse + SignalPulse under one Saber-branded home page.
