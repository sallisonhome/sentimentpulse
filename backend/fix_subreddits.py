"""
One-time script to populate subreddits for all known Saber Interactive games.
Run from the backend directory:
    source .venv/bin/activate && python fix_subreddits.py
"""
from database import SessionLocal
from models import Game

# General gaming subs used as fallback for games without dedicated communities.
# PullPush will search these by game name.
_GENERAL_FALLBACK = ["gaming", "pcgaming", "Games"]

# Mapping: game_id → list of relevant subreddits
SUBREDDIT_MAP = {
    1:   _GENERAL_FALLBACK,  # Docked
    2:   ["TempestRising"],  # Tempest Rising
    3:   ["AQuietPlace", "gaming"],  # A Quiet Place: The Road Ahead
    4:   _GENERAL_FALLBACK,  # The Knightling
    5:   ["dakardesertrally", "DakartheGame"],  # Dakar Desert Rally
    20:  ["JohnWick", "gaming"],  # Untitled John Wick Game
    21:  ["hellraiser", "gaming"],  # Clive Barker's Hellraiser: Revival
    22:  ["JurassicPark", "gaming"],  # Jurassic Park: Survival
    23:  ["Turok", "gaming"],  # Turok: Origins
    24:  ["Spacemarine", "SpaceMarine_2"],  # Warhammer 40K: Space Marine 2
    25:  ["gaming", "pcgaming"],  # John Carpenter's Toxic Commando
    26:  ["halo", "HaloMCC"],  # Halo: The Master Chief Collection
    27:  ["snowrunner"],  # SnowRunner
    28:  ["gaming", "pcgaming"],  # RoadCraft
    29:  ["Gloomhaven"],  # Gloomhaven
    33:  ["Mudrunner", "snowrunner"],  # Expeditions: A MudRunner Game
    36:  ["Mudrunner"],  # MudRunner
    37:  ["Crysis"],  # Crysis 3 Remastered
    39:  ["Crysis"],  # Crysis 2 Remastered
    43:  ["GhostbustersGame", "ghostbusters"],  # Ghostbusters Remastered
    60:  ["gaming"],  # TimeShift
    87:  ["gaming"],  # MX Nitro
    98:  ["gaming"],  # Inversion
    104: ["halo", "HaloMCC"],  # Halo 2: Anniversary
    105: ["halo", "HaloMCC"],  # Halo 3
    123: ["Mudrunner", "snowrunner"],  # MudRunner Old-timers DLC
    124: ["gaming"],  # RoadCraft Reclaim Expansion
}

def main():
    db = SessionLocal()
    updated = 0
    for game_id, subs in SUBREDDIT_MAP.items():
        if not subs:
            continue
        game = db.query(Game).filter_by(id=game_id).first()
        if not game:
            print(f"  SKIP: game_id={game_id} not found in DB")
            continue
        old = game.subreddits or []
        game.subreddits = subs
        print(f"  {game.name}: {old} → {subs}")
        updated += 1

    db.commit()
    db.close()
    print(f"\nDone — updated {updated} game(s).")

if __name__ == "__main__":
    main()
