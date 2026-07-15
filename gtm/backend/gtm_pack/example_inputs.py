"""Dummy data for the public-facing /example deck (Phase 3 — GTM Phase 3+4).

THIS IS FICTIONAL DUMMY DATA. "Blackwood Hollow" is not a real game; all
numbers, quotes, and cohort sizes below are illustrative only, chosen to
demonstrate every field in the 6-slide pack (including the 5th
disabled-USP toggle and a duplicate "High" risk level).

Distinct from `sample_inputs.py` (SAMPLE_INPUTS), which backs the pytest
suite (`tests/test_render_full_pack.py`) and must stay stable so existing
test assertions don't need to change. This module is the seed for the
public /example endpoint only.

CURRENCY UNITS (see gtm_revisions_summary.md for the correction history):
  - median_revenue_usd_millions: MILLIONS of dollars (4.7 == $4.7M)
  - avg_price_usd: PLAIN dollars (39.99)
  - median_units_sold: raw integer unit count (1_782_675)
"""

EXAMPLE_INPUTS = {
    "title": "Blackwood Hollow",
    "genre": "Psychological Horror",
    "game_type": "new_ip_with_fans",  # New IP with existing fanbase
    "inner": "dev",                    # Developer Fans
    "release_date": "2027-10-31",       # Halloween 2027
    "cohorts": [
        {"name": "Developer Fans",              "size": 450_000},
        {"name": "IP Fans",                      "size": 1_200_000},
        {"name": "Genre Fans (Top 5 avg)",       "size": 4_800_000},
        {"name": "Breakout Ceiling",             "size": 9_500_000},
    ],

    # Step 5 — Median Commercial Potential
    "comp_set_name": "Horror — 19 titles",
    "median_revenue_usd_millions": 4.7,
    "avg_price_usd": 39.99,
    "median_units_sold": 1_782_675,
    "avg_hours_played": 18.7,
    "platforms": ["PC", "PS5", "XSX", "SWITCH2"],

    # Step 2 — USPs (5 total, 5th disabled to demonstrate the toggle)
    "usps": [
        {
            "title": "A house that remembers what you did",
            "description": (
                "Blackwood Hollow's manor persists state across every playthrough — "
                "doors you barred stay barred, notes you burned stay ash."
            ),
            "proof": "Closed alpha: 92% of testers noticed a persistent-state callback unprompted",
            "strategy": "Lead every trailer with a callback the player caused, not scripted horror.",
            "enabled": True,
        },
        {
            "title": "Sound-first dread, not jump-scare spam",
            "description": (
                "Binaural audio design tracks the entity's position independent of "
                "the camera — dread comes from what you hear, not what pops on screen."
            ),
            "proof": "Alpha feedback: jump-scare complaints down 70% vs. genre-average horror playtests",
            "strategy": "Ship a headphones-required audio-only teaser as the first marketing beat.",
            "enabled": True,
        },
        {
            "title": "No combat, no exceptions",
            "description": (
                "Every escape is environmental — traps, misdirection, and light management, "
                "never a weapon. This is a deliberate genre stance, not a budget cut."
            ),
            "proof": "Design doc locked pre-production; zero combat animations in the build",
            "strategy": "Use 'no combat, no exceptions' verbatim as a store-page pull-quote.",
            "enabled": True,
        },
        {
            "title": "A map that's honest, then lies to you",
            "description": (
                "The manor's floor plan is consistent for the first two acts, then "
                "begins to visibly contradict itself once the entity notices the player."
            ),
            "proof": "Playtest note: 'I drew my own map and it betrayed me' — most-quoted alpha feedback",
            "strategy": "Tease the map-integrity break in a dedicated gameplay reveal, not the launch trailer.",
            "enabled": True,
        },
        {
            "title": "Companion AI that can lie to you",
            "description": (
                "An optional radio companion offers guidance that is occasionally wrong — "
                "cut for scope in the current build, parked for a post-launch update."
            ),
            "proof": "Prototype exists but is not in the shipping build",
            "strategy": "Do not market this feature until it ships — parking lot only.",
            "enabled": False,
        },
    ],

    # Step 3 — Reach (4 cohorts, inner -> outer)
    "reach": [
        {
            "cohort": "Developer Fans",
            "channel": "Discord, Newsletter",
            "message": "The team behind [prior title] built something quieter and colder",
            "kpi": "55% wishlist conversion from owned list",
        },
        {
            "cohort": "IP Fans",
            "channel": "Reddit, YouTube",
            "message": "The universe you know, seen through a door you shouldn't open",
            "kpi": "15 lore-explainer videos in first 30 days",
        },
        {
            "cohort": "Genre Fans (Top 5 avg)",
            "channel": "Horror streamers, TikTok",
            "message": "The scares are quieter. The dread does not let up.",
            "kpi": "8M short-form views pre-launch",
        },
        {
            "cohort": "Breakout Ceiling",
            "channel": "Curator outreach, paid social",
            "message": "If Resident Evil 7's house made you nervous, this one keeps a diary",
            "kpi": "1M wishlist adds from curator + paid reach",
        },
    ],

    # Step 6 — Commercial Risks (5: Critical, High x2, Medium, Low)
    "risks": [
        {
            "threat_level": "critical",
            "proof": "Steam algorithmic visibility depends on early wishlist velocity, which is thin for new horror IP without a demo",
            "mitigation": "Ship a public demo 90 days pre-launch to seed wishlist velocity before the algorithm needs it",
        },
        {
            "threat_level": "high",
            "proof": "Three other horror titles have announced Q4 2027 windows, same audience pool",
            "mitigation": "Lock marketing beats to land 6-8 weeks ahead of the nearest confirmed competitor date",
        },
        {
            "threat_level": "high",
            "proof": "Marketing budget sits below genre median for AAA-adjacent visual fidelity",
            "mitigation": "Concentrate spend on 3 owned beats (demo, reveal trailer, launch) instead of sustained paid presence",
        },
        {
            "threat_level": "medium",
            "proof": "Switch 2 certification queue has run 3-5 weeks longer than quoted for recent horror submissions",
            "mitigation": "Submit the Switch 2 cert build 6 weeks ahead of the internal buffer, not the platform's stated minimum",
        },
        {
            "threat_level": "low",
            "proof": "Russian and Portuguese localization QA scope was estimated before voice-over line count was final",
            "mitigation": "Cap localization QA to text-only for RU/PT at launch; defer VO localization to a post-launch patch",
        },
    ],

    # Step 7 — Description & Razors
    "description_100": (
        "Blackwood Hollow is a first-person psychological horror game about a house "
        "that keeps score. You return to your family's abandoned manor to settle an "
        "estate, and the manor answers by remembering everything you do — every door "
        "you bar, every note you burn, every room you avoid. There is no combat, only "
        "escape: environmental puzzles, light management, and a floor plan that stays "
        "honest only as long as the house believes you aren't paying attention. Binaural "
        "audio tracks the presence stalking you independent of the camera, so the dread "
        "follows your ears, not your screen. Built for players who want horror that "
        "thinks, not horror that jumps."
    ),
    "razor_20": "A house that remembers everything you do — and lies about its own floor plan.",
    "razor_10": "The house remembers. The map lies. Leave if you can.",
}
