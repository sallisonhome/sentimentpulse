"""Canonical sample inputs for the example pack and tests.

Mirrors the payload in the build spec (Section 10) and the skill's last QA fixture.
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
    "usps": [
        {
            "title": "Two-player puzzles that need both brains",
            "description": "Every chamber requires asymmetric input from each player — no carrying.",
            "proof": "Internal playtests: 0% of pairs completed Act 1 solo",
        },
        {
            "title": "Hand-drawn worlds, no procgen",
            "description": "150 chambers, each illustrated by hand. Replayability is in the speedrun.",
            "proof": "150 hand-drawn chambers ship in the base game",
        },
        {
            "title": "Drop-in, drop-out anywhere",
            "description": "Friend joins mid-chamber and inherits a fair share of the puzzle state.",
            "proof": "Average rejoin time: 4 seconds",
        },
        {
            "title": "Built for streaming",
            "description": "Spectator-friendly camera, named puzzle moments, no cluttered HUD.",
            "proof": "Press preview: 'the most watchable co-op puzzle since Portal 2'",
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
}
