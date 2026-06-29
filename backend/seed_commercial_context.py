"""Seed default commercial-strategic context briefs for the 8 priority titles.

CLAUDE.md §21 (Commercial Strategic Context).  These briefs tell the
summary LLM what comparisons are commercial ASSETS to amplify, what
genre tailwinds to ride, and what threats to differentiate from.  Without
these, the LLM has previously recommended counter-positioning AWAY from
positive market signals (e.g. "distance from Resident Evil comparisons"
when RE is the #1 commercial horror of 2026 — a clear strategic error).

Sources for the 2026 commercial context:
- Resident Evil Requiem (Feb 27 2026): 7M+ units in 2 months, fastest-
  selling RE ever, Metacritic 89-92, fastest-selling Capcom title since
  Monster Hunter Wilds; Capcom raised profit forecast on Requiem alone
  (IGN, Forbes, Eurogamer, Capcom IR).
- Silent Hill f (2025) reset Konami survival horror; Crow Country
  validated PS1-style horror as a real tier (GBHBL 2026 horror review).
- Halloween: The Game (Sept 8 2026): asymmetrical 1v4 multiplayer horror
  (PlayStation Blog, Steam).  Single-player survival horror titles
  differentiate against asymmetrical multiplayer, not against each other.
- "Widespread desire for high-caliber single-player experiences in a
  marketplace dominated by live-service multiplayer titles" — Forbes
  citing Circana on the Requiem launch.

These defaults are written conservatively.  The user can override per
title via PATCH /api/games/{id} commercial_context, edited on the
per-title card in the Settings page.

Run manually:  python -m seed_commercial_context
Or via the maintenance endpoint that calls seed_default_commercial_context().
"""

from sqlalchemy.orm import Session

from database import SessionLocal
from models import Game

# ─── 2026 horror commercial context defaults ────────────────────────────────
# Keep each brief to 4-6 sentences, naming concrete commercial benchmarks the
# LLM can reason against.

DEFAULTS: dict[int, str] = {
    21: (  # Clive Barker's Hellraiser: Revival
        "POSITIONING: Single-player survival horror anchored on the authentic Hellraiser IP "
        "(Pinhead, Cenobites, the puzzle box) with Clive Barker as creative authority and "
        "Doug Bradley returning to voice Pinhead.\n"
        "COMMERCIAL TAILWIND TO AMPLIFY: Resident Evil Requiem (Feb 2026) sold 7M+ units in "
        "2 months and reset the bar for single-player survival horror in 2026 — comparisons "
        "from the community to RE are an ASSET (the market is telling you the genre and "
        "atmosphere resonate). Lean into the comparison + ADD what makes us authentically "
        "Hellraiser (IP, Barker, Bradley, puzzle-box mythology). Silent Hill f also validated "
        "premium single-player horror as a commercial tier.\n"
        "THREAT TO DIFFERENTIATE FROM: Halloween: The Game (Sept 8, 2026) is asymmetrical "
        "1v4 multiplayer — Hellraiser Revival's differentiation play is single-player + "
        "auteur-driven horror, NOT distance from RE.\n"
        "DO NOT: advise the team to counter-position away from RE / survival horror "
        "comparisons. The comparison is a marketing gift; amplify with authenticity."
    ),
    24: (  # Warhammer 40,000: Space Marine 2
        "POSITIONING: Live 3rd-person co-op action shooter in the Warhammer 40K universe; "
        "the franchise's biggest commercial moment to date.\n"
        "COMMERCIAL CONTEXT: Already a released, supported live game with hundreds of "
        "thousands of concurrent players historically. The signal mix is post-launch: "
        "patch-driven balance discussion, stratagems / class meta, performance, server / "
        "matchmaking — all are LIVE-GAME signals, not pre-release marketing inputs.\n"
        "TAILWINDS TO AMPLIFY: 40K IP recognition, deep faction lore, co-op as a sticky "
        "live-service format. When community talks about Salamanders, Black Templars, or "
        "specific stratagems, those are LIVE-OPS opportunities — amplify with content "
        "drops, not counter-positioning.\n"
        "THREATS: live-service competition for play-time, not other 40K titles. The "
        "differentiator is faction breadth + co-op authenticity.\n"
        "DO NOT: recommend marketing repositioning away from co-op or away from the 40K "
        "fantasy — that's the moat."
    ),
    25: (  # John Carpenter's Toxic Commando
    "POSITIONING: 4-player co-op shooter with John Carpenter creative attachment and a "
    "B-movie horror / pulp aesthetic. Released live game with a sizable engaged community.\n"
    "COMMERCIAL TAILWIND: 4-player co-op is durable as a format (Helldivers 2, Deep Rock "
    "Galactic, Space Marine 2 all proven). Carpenter brand + cult-horror tone is a real "
    "audience hook for genre fans.\n"
    "THREAT: live-service co-op shooters compete on session quality and patch cadence — "
    "performance issues / black-screen complaints are LIABILITY signals that need real "
    "patching, not messaging.\n"
    "DO NOT: counter-position away from comparisons to Helldivers or Left 4 Dead style "
    "co-op horror; those comparisons are commercial validation. Lean in + cite the "
    "Carpenter atmosphere as differentiator."
    ),
    23: (  # Turok: Origins
        "POSITIONING: 1-3 player co-op shooter reviving the Turok IP (originally Acclaim "
        "1997+, beloved on N64). Pre-release, building anticipation through trailers + "
        "showcase coverage.\n"
        "COMMERCIAL TAILWIND: PS1/N64-era nostalgia is a commercially proven 2026 tier "
        "(Crow Country, Silent Hill f appeal to the same buyer cohort). Co-op shooters "
        "with strong IP can punch above their weight (Space Marine 2 proved this).\n"
        "THREAT TO DIFFERENTIATE FROM: generic dinosaur shooters and live-service FPS — "
        "Turok's moat is the IP and the N64-shooter feel modernized for 3-player co-op.\n"
        "DO NOT: counter-position away from comparisons to Space Marine 2 or other co-op "
        "shooters — those comparisons commercially validate the format. Lean in + "
        "differentiate on Turok IP authenticity."
    ),
    134: (  # Bus Bound
        "POSITIONING: Small-scope indie sim/strategy title.  Single-player or limited "
        "multiplayer, niche genre, low marketing budget relative to AAA peers.\n"
        "COMMERCIAL CONTEXT: Indie sim/strategy has a smaller commercial ceiling but a "
        "very loyal long-tail audience.  Don't try to position against AAA peers; the "
        "right play is finding the engaged niche and amplifying community-driven "
        "validation (streamer playthroughs, reddit organic conversation).\n"
        "TAILWIND TO AMPLIFY: any organic comparison to other beloved indie sims is a "
        "gift — those comparisons mean the right audience is finding the game.\n"
        "DO NOT: recommend AAA-marketing actions that don't fit indie scale (e.g. major "
        "platform-wide campaigns, $$$ trailer reveals).  Tone the recommendations to "
        "indie-appropriate scale."
    ),
    131: (  # HITMAN Classic Trilogy Remastered
        "POSITIONING: Remaster bundle of the original HITMAN trilogy (Codename 47, "
        "Silent Assassin, Contracts).  Pre-release / launch-window.\n"
        "COMMERCIAL TAILWIND: Resident Evil Generation Pack (RE7 + Village + Requiem "
        "bundle) was a 2026 commercial hit, validating the franchise-bundle remaster "
        "format.  Crow Country's PS1-style nostalgia tier validates buyer appetite for "
        "remastered classic-era content.\n"
        "AUDIENCE: existing HITMAN World of Assassination fanbase + nostalgia buyers for "
        "early-2000s stealth genre.\n"
        "THREAT: modern stealth alternatives (HITMAN WoA itself, Sniper Elite, etc.) — "
        "the differentiation play is auteur-Reto + original-era authenticity.\n"
        "DO NOT: counter-position away from comparisons to modern HITMAN WoA; those "
        "comparisons are commercial signals that the audience is engaged.  Lean in."
    ),
    20: (  # Untitled John Wick Game
        "POSITIONING: Pre-release / early-marketing.  John Wick IP — one of the most "
        "commercially-recognized action IPs of the last decade.  Format and platform "
        "details may still be evolving in public messaging.\n"
        "COMMERCIAL TAILWIND: action / shooter IPs with strong cinematic attachment have "
        "outperformed in 2026 (Saber's own Space Marine 2 as recent proof point).  The "
        "John Wick brand is a tailwind to amplify; comparisons to action-shooter peers "
        "are validating signal.\n"
        "AUDIENCE: action film fans + co-op shooter audience.\n"
        "DO NOT: counter-position away from action-shooter comparisons.  Differentiate "
        "on John Wick cinematic feel + Saber's proven action-shooter execution."
    ),
    130: (  # Stuntman: Hollywood
        "POSITIONING: Revival of the Stuntman IP (originally Reflections / Atari 2002+), "
        "pre-release / early marketing.\n"
        "COMMERCIAL CONTEXT: vehicular / stunt-driving titles have a niche but durable "
        "audience.  Nostalgia for PS2-era driving games is a real 2026 cohort.\n"
        "TAILWIND TO AMPLIFY: any organic comparison to Burnout, Driver, or the original "
        "Stuntman are commercial signals — those audiences are exactly the buyer cohort.\n"
        "THREAT: simulation racers (Forza, Gran Turismo) — differentiate on arcade feel + "
        "stunt-cinematic angle.\n"
        "DO NOT: counter-position away from comparisons to PS2-era driving titles; those "
        "comparisons are the audience finding the game."
    ),
}


def seed_default_commercial_context(db: Session, *, overwrite: bool = False) -> dict:
    """Apply default briefs to any of the 8 priority titles that don't have
    one yet.  When overwrite=True, replaces existing briefs (use with care).
    Returns a {game_id: action} dict for logging.
    """
    actions: dict[int, str] = {}
    for game_id, brief in DEFAULTS.items():
        game = db.query(Game).filter_by(id=game_id).first()
        if game is None:
            actions[game_id] = "missing"
            continue
        if game.commercial_context and not overwrite:
            actions[game_id] = "skipped (has brief)"
            continue
        game.commercial_context = brief
        actions[game_id] = "set" if not game.commercial_context else "overwritten"
    db.commit()
    return actions


if __name__ == "__main__":
    db = SessionLocal()
    try:
        result = seed_default_commercial_context(db, overwrite=False)
        for game_id, action in result.items():
            print(f"  game {game_id}: {action}")
    finally:
        db.close()
