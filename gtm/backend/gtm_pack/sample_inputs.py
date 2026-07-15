"""Canonical sample inputs for the example pack and tests.

Mirrors the payload in the build spec (Section 10) and the skill's last QA fixture.

CURRENCY UNITS (see gtm_revisions_summary.md for the correction history):
  - median_revenue_usd_millions: MILLIONS of dollars (4.7 == $4.7M)
  - avg_price_usd: PLAIN dollars (39.99)
  - median_units_sold: raw integer unit count (1_782_675)
"""

SAMPLE_INPUTS = {
    "title": "Sample Game Title",
    "genre": "Co-op puzzle adventure",
    "game_type": "sequel",  # one of: sequel | new_ip_with_fans | custom
    "inner": "prev",        # one of: prev | dev | other
    "release_date": "2027-03-15",
    "cohorts": [
        {"name": "Core fans of the original",  "size": 75000},
        {"name": "Co-op puzzle enthusiasts",   "size": 350000},
        {"name": "Couch co-op gamers",         "size": 1200000},
        {"name": "Adjacent indie PC gamers",   "size": 4500000},
    ],

    # Median Commercial Potential (Revision 1, NEW)
    "comp_set_name": "Co-op puzzle adventure — 12 titles",
    "median_revenue_usd_millions": 4.7,
    "avg_price_usd": 39.99,
    "median_units_sold": 1_782_675,
    "avg_hours_played": 18.7,
    "platforms": ["PC", "PS5", "XSX", "SWITCH2"],
    "usps": [
        {
            "title": "Two-player puzzles that need both brains",
            "description": "Every chamber requires asymmetric input from each player — no carrying.",
            "proof": "Internal playtests: 0% of pairs completed Act 1 solo",
            "strategy": "Lead every trailer with an asymmetric two-player beat.",
            "enabled": True,
        },
        {
            "title": "Hand-drawn worlds, no procgen",
            "description": "150 chambers, each illustrated by hand. Replayability is in the speedrun.",
            "proof": "150 hand-drawn chambers ship in the base game",
            "strategy": "Feature hand-drawn art in every store page screenshot.",
            "enabled": True,
        },
        {
            "title": "Drop-in, drop-out anywhere",
            "description": "Friend joins mid-chamber and inherits a fair share of the puzzle state.",
            "proof": "Average rejoin time: 4 seconds",
            "strategy": "Demo drop-in/out live during every streamed preview.",
            "enabled": True,
        },
        {
            "title": "Built for streaming",
            "description": "Spectator-friendly camera, named puzzle moments, no cluttered HUD.",
            "proof": "Press preview: 'the most watchable co-op puzzle since Portal 2'",
            "strategy": "Seed streamer keys 4 weeks pre-launch.",
            "enabled": True,
        },
    ],
    "reach": [
        {
            "cohort": "Core fans of the original",
            "channel": "Owned mailing list, Discord",
            "message": "It's the sequel you asked for — same studio, evolved core loop",
            "kpi": "60% wishlist conversion from list",
        },
        {
            "cohort": "Co-op puzzle enthusiasts",
            "channel": "Long-form YouTube creators, Reddit",
            "message": "The asymmetric two-player puzzler genre has a new high-water mark",
            "kpi": "20 YT review videos in first 30 days",
        },
        {
            "cohort": "Couch co-op gamers",
            "channel": "TikTok, Reels, Shorts",
            "message": "The funniest co-op game your group will play this year",
            "kpi": "5M short-form views pre-launch",
        },
        {
            "cohort": "Adjacent indie PC gamers",
            "channel": "Curator outreach, indie newsletter sponsorships",
            "message": "If you loved It Takes Two or Baba Is You, you'll love this",
            "kpi": "500K wishlist adds from curator pages",
        },
    ],

    # Commercial Risks (Revision 3, NEW)
    "risks": [
        {
            "threat_level": "critical",
            "proof": "Two AAA co-op titles ship in the same release window",
            "mitigation": "Lock release date 6 weeks ahead of the nearest announced competitor",
        },
        {
            "threat_level": "high",
            "proof": "Co-op puzzle genre CCU has plateaued per Genre Pulse",
            "mitigation": "Diversify marketing into broader indie-couch-gaming audiences",
        },
        {
            "threat_level": "medium",
            "proof": "Cross-play certification timelines vary by platform",
            "mitigation": "Submit cross-play builds 8 weeks ahead of the internal deadline",
        },
        {
            "threat_level": "low",
            "proof": "Localization budget covers only 3 languages at launch",
            "mitigation": "Ship EN/FR/DE at launch, add more post-launch based on wishlist geography",
        },
    ],

    # Description & Razors (Revision 4, NEW)
    "description_100": (
        "Sample Game Title drops two players into a fractured mansion where every "
        "room is a puzzle built for two different minds. One partner sees the "
        "mechanism, the other holds the missing piece, and neither can finish a "
        "chamber alone. A hand-drawn world of 150 illustrated rooms rewards "
        "careful looking over fast reflexes, and a drop-in, drop-out netcode means "
        "a friend can join mid-puzzle without breaking the flow. Built for couch "
        "co-op and long-distance duos alike, with a spectator-friendly camera. "
        "No combat, no fail states -- just two people, one house, and puzzles "
        "that only make sense together."
    ),
    "razor_20": "A mansion built for two minds -- every room is a puzzle neither of you can solve alone.",
    "razor_10": "Two minds. One house. No solving it solo.",
}
