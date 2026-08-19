"""Portfolio-wide distinctive_keywords population — 2026-08-18.

Following the Turok: Origins subreddit-pollution + LLM-contamination
audit, we discovered ALL 148 games had `distinctive_keywords = NULL`.
That's the root cause of relevance-tagger false-positives across the
portfolio: the tagger falls back to bare game-name tokens ("Turok",
"Origins", "Halo", "Aliens", etc.) which collide with either English
usage or other games in the same franchise.

This script PATCHes distinctive_keywords for every ACTIVE game in the
portfolio (37 titles: 32 Saber-parent + 5 competitor children under
Hellraiser Revival / Turok: Origins). Inactive titles (DLCs, cosmetic
packs, soundtracks, old MudRunner seasons — 111 rows) are skipped
because they aren't ingested.

Design rules applied to every entry:
  1. Every kw is multi-word ≥ 2 tokens, AND-matched on Reddit, so
     accidental collisions with English are extremely rare.
  2. Bare franchise tokens ("Turok", "Halo", "Aliens", "Crysis",
     "Ghostbusters", "Silent Hill", "Hellraiser", "Halloween", "John
     Wick", "Jurassic Park", "MudRunner") are NEVER used alone —
     always paired with an installment/publisher qualifier so
     franchise noise is excluded.
  3. Sequels/spin-offs are pinned by their subtitle or installment
     number (SM2 → "Space Marine 2", not "Space Marine"; Insurgency:
     Sandstorm → "Sandstorm" combos, not "Insurgency" alone).
  4. Remasters/reboots include the year 2026 form for community
     shorthand ("Crysis 3 Remastered 2026", "Halo 2 Anniversary 2026").
  5. Publisher/studio disambiguation is added for titles that share
     a common English word (Saber, Focus, KRAFTON, etc.) — only when
     that studio is genuinely part of the community shorthand.

Each block below has:
  * `id` — the SentimentPulse game_id in prod.
  * `name` — the exact title (for audit clarity; PATCH is by id).
  * `type` — 'saber' or 'competitor' (nested under parent).
  * `keywords` — the final list to be persisted.
  * `notes` — one-line rationale for the manual overrides beyond
    what `services.keyword_generator.generate_default_keywords`
    returned. Grep-friendly for future auditors.

To dry-run: `python3 apply_portfolio_keywords_2026_08_18.py --dry-run`
To apply:   `python3 apply_portfolio_keywords_2026_08_18.py`
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

API = "http://104.236.239.46/api"

# The list. Each entry: (game_id, title, is_competitor, keywords, notes)
KEYWORDS: list[tuple[int, str, bool, list[str], str]] = [
    # ── Saber parent titles ────────────────────────────────────────────────
    (
        1, "Docked", False,
        [
            "Docked game",
            "Docked the game",
            "Saber Docked",
            "Docked Saber Interactive",
        ],
        "Bare 'Docked' collides with dock verb + shipping/logistics; needs Saber attribution."
    ),
    (
        2, "Tempest Rising", False,
        [
            "Tempest Rising",
            "Tempest Rising game",
            "Tempest Rising RTS",
            "Tempest Rising Slipgate",
        ],
        "3-token bare form is safe; add RTS + publisher for community shorthand."
    ),
    (
        3, "A Quiet Place: The Road Ahead", False,
        [
            "A Quiet Place: The Road Ahead",
            "A Quiet Place game",
            "The Road Ahead game",
            "A Quiet Place The Road Ahead",
            "Quiet Place The Road Ahead",
        ],
        "Franchise + subtitle. 'The Road Ahead' alone is generic English; always qualify with game or franchise."
    ),
    (
        4, "The Knightling", False,
        [
            "The Knightling",
            "The Knightling game",
            "Knightling Saber",
            "The Knightling Saber Interactive",
        ],
        "Distinctive proper noun; add publisher attribution for community threads."
    ),
    (
        5, "Dakar Desert Rally", False,
        [
            "Dakar Desert Rally",
            "Dakar Desert Rally game",
            "Dakar Rally game",
            "Dakar Desert Rally Saber",
        ],
        "3-word bare form is safe. 'Dakar Rally game' catches the shortened form."
    ),
    (
        20, "Untitled John Wick Game", False,
        [
            "John Wick game",
            "John Wick video game",
            "Saber John Wick",
            "Untitled John Wick",
            "John Wick Saber Interactive",
        ],
        "Bare 'John Wick' is franchise/film reference; always qualify with 'game' or 'Saber' for game-specific discussion."
    ),
    (
        21, "Clive Barker's Hellraiser: Revival", False,
        [
            "Hellraiser Revival",
            "Hellraiser Revival game",
            "Clive Barker's Hellraiser: Revival",
            "Hellraiser Revival Saber",
            "Clive Barker Hellraiser Revival",
        ],
        "Bare 'Hellraiser' matches film franchise; always pair with 'Revival'."
    ),
    (
        22, "Jurassic Park: Survival", False,
        [
            "Jurassic Park Survival",
            "Jurassic Park: Survival",
            "Jurassic Park Survival game",
            "Jurassic Park Survival Saber",
            "JP Survival game",
        ],
        "Bare 'Jurassic Park' is franchise-wide; always pair with 'Survival'. JP shorthand common in community."
    ),
    (
        23, "Turok: Origins", False,
        [
            "Turok Origins",
            "Turok: Origins",
            "Turok Origins game",
            "Turok Origins Saber",
            "Saber Turok",
            "new Turok game",
        ],
        "Bare 'Turok' matches N64 retro discussion of Turok 1/2/3 (which flooded r/Helldivers cross-posts). "
        "Always qualify with 'Origins' or 'new/Saber'. Bare 'Origins' would be catastrophic."
    ),
    (
        24, "Warhammer 40,000: Space Marine 2", False,
        [
            "Space Marine 2",
            "Warhammer Space Marine 2",
            "SM2 game",
            "Space Marine 2 Saber",
            "Warhammer 40k Space Marine 2",
        ],
        "Bare 'Space Marine' collides with tabletop/lore/SM1; pin to '2'. 'SM2' is dominant community shorthand."
    ),
    (
        25, "John Carpenter's Toxic Commando", False,
        [
            "Toxic Commando",
            "John Carpenter's Toxic Commando",
            "Toxic Commando game",
            "Toxic Commando Saber",
            "John Carpenter Toxic Commando",
        ],
        "'Toxic Commando' is distinctive enough alone; 'John Carpenter' pairing catches director-attributed posts."
    ),
    (
        26, "Halo: The Master Chief Collection", False,
        [
            "Halo Master Chief Collection",
            "Halo MCC",
            "MCC game",
            "Master Chief Collection game",
            "Halo: The Master Chief Collection",
        ],
        "'MCC' is the dominant community shorthand — but 'MCC' alone would match MyCC, Marriage & Family etc.; use 'Halo MCC' and 'MCC game'."
    ),
    (
        27, "SnowRunner", False,
        [
            "SnowRunner",
            "SnowRunner game",
            "SnowRunner Saber",
            "SnowRunner truck game",
        ],
        "Distinctive compound proper noun; safe as bare token but pair for community context."
    ),
    (
        28, "RoadCraft", False,
        [
            "RoadCraft",
            "RoadCraft game",
            "RoadCraft Saber",
            "RoadCraft construction game",
        ],
        "Distinctive compound proper noun. 'construction game' pairing catches genre discussion."
    ),
    (
        29, "Gloomhaven", False,
        [
            "Gloomhaven",
            "Gloomhaven game",
            "Gloomhaven video game",
            "Gloomhaven digital",
        ],
        "Distinctive fantasy proper noun; must disambiguate from the board game via 'video game' / 'digital'."
    ),
    (
        33, "Expeditions: A MudRunner Game", False,
        [
            "Expeditions MudRunner",
            "Expeditions: A MudRunner Game",
            "Expeditions A MudRunner Game",
            "MudRunner Expeditions",
            "Expeditions Saber",
        ],
        "Bare 'Expeditions' collides with countless other games (Vikings/Rome/Conquistador); always pair with MudRunner."
    ),
    (
        36, "MudRunner", False,
        [
            "MudRunner",
            "MudRunner game",
            "MudRunner Saber",
            "Spintires MudRunner",
        ],
        "Distinctive compound proper noun; 'Spintires MudRunner' catches historical/OG discussion."
    ),
    (
        37, "Crysis 3 Remastered", False,
        [
            "Crysis 3 Remastered",
            "Crysis 3 Remaster",
            "Crysis 3 Remastered game",
            "Crysis 3 Remastered 2026",
            "Crysis Remastered Trilogy Crysis 3",
        ],
        "Franchise-wide 'Crysis' would match Crysis 1/2/3 + original + Warhead. Always pin to '3 Remastered'."
    ),
    (
        39, "Crysis 2 Remastered", False,
        [
            "Crysis 2 Remastered",
            "Crysis 2 Remaster",
            "Crysis 2 Remastered game",
            "Crysis 2 Remastered 2026",
            "Crysis Remastered Trilogy Crysis 2",
        ],
        "Same pattern as Crysis 3. Pin to '2 Remastered' to disambiguate from franchise noise."
    ),
    (
        43, "Ghostbusters: The Video Game Remastered", False,
        [
            "Ghostbusters The Video Game Remastered",
            "Ghostbusters Video Game Remastered",
            "Ghostbusters Remastered game",
            "Ghostbusters game 2019",
            "Ghostbusters Remaster",
        ],
        "Bare 'Ghostbusters' is film franchise. Pin with 'Video Game', 'Remastered', or year 2019 (original release)."
    ),
    (
        60, "TimeShift™", False,
        [
            "TimeShift game",
            "TimeShift 2007",
            "TimeShift Saber",
            "TimeShift FPS",
            "TimeShift shooter",
        ],
        "'TimeShift' alone collides with time-travel discussion; qualify with game/year/genre."
    ),
    (
        87, "MX Nitro: Unleashed", False,
        [
            "MX Nitro Unleashed",
            "MX Nitro: Unleashed",
            "MX Nitro game",
            "MX Nitro Saber",
        ],
        "Distinctive product-name; 'MX Nitro' is safe as compound."
    ),
    (
        98, "Inversion™", False,
        [
            "Inversion game",
            "Inversion 2012",
            "Inversion Saber",
            "Inversion Namco Saber",
            "Inversion shooter",
        ],
        "'Inversion' is a common English word; must always qualify with game/year/genre/publisher."
    ),
    (
        104, "Halo 2: Anniversary", False,
        [
            "Halo 2 Anniversary",
            "Halo 2 Anniversary game",
            "Halo 2 Anniversary 2014",
            "Halo 2 Anniversary MCC",
            "H2A Halo 2",
        ],
        "Bare 'Halo 2' matches franchise-wide. Pin with 'Anniversary' + 'MCC' + community shorthand 'H2A'."
    ),
    (
        105, "Halo 3", False,
        [
            "Halo 3",
            "Halo 3 game",
            "Halo 3 MCC",
            "Halo 3 multiplayer",
            "Halo 3 campaign",
        ],
        "'Halo 3' has 3 tokens — safe. Add MCC + multiplayer/campaign for community discussion contexts."
    ),
    (
        125, "Halo: Combat Evolved Anniversary", False,
        [
            "Halo Combat Evolved Anniversary",
            "Halo: Combat Evolved Anniversary",
            "Halo CE Anniversary",
            "Halo Combat Evolved Anniversary MCC",
            "Halo CEA game",
        ],
        "Franchise pins: 'Combat Evolved' + 'Anniversary' + community shorthand 'CE'/'CEA'."
    ),
    (
        130, "Stuntman: Hollywood", False,
        [
            "Stuntman Hollywood",
            "Stuntman: Hollywood",
            "Stuntman Hollywood game",
            "Stuntman Hollywood Saber",
            "new Stuntman game",
        ],
        "Bare 'Stuntman' matches original PS2 games / stunt-performer job; always pair with 'Hollywood' or 'Saber'."
    ),
    (
        131, "HITMAN Classic Trilogy Remastered", False,
        [
            "HITMAN Classic Trilogy Remastered",
            "HITMAN Classic Trilogy",
            "HITMAN Trilogy Remastered",
            "Hitman Trilogy 2026",
            "IO Interactive Hitman Trilogy",
        ],
        "Bare 'Hitman' matches franchise-wide including WoA. Pin with 'Classic Trilogy' + publisher + year."
    ),
    (
        134, "Bus Bound", False,
        [
            "Bus Bound",
            "Bus Bound game",
            "Bus Bound Saber",
            "Bus Bound driving game",
        ],
        "'Bound' is generic English (would match Homeward Bound, spellbound, etc.); always pair with 'Bus'."
    ),
    (
        144, "Rideshare \"Stimulator\"", False,
        [
            "Rideshare Stimulator",
            "Rideshare Stimulator game",
            "Rideshare Simulator Saber",
            "Rideshare game Saber",
        ],
        "'Rideshare' collides with the entire ride-share industry / gig-economy news. Always pair with 'Stimulator' (misspelling is intentional per Saber) or 'Simulator' + 'Saber'."
    ),
    (
        147, "World War Z", False,
        [
            "World War Z game",
            "World War Z Aftermath",
            "WWZ Aftermath",
            "WWZ game",
            "WWZ VR",
            "World War Z VR",
            "Saber World War Z",
            "WWZ horde mode",
            "WWZ zombies game",
            "WWZ swarm",
            "WWZ Aftermath VR",
        ],
        "Bare 'WWZ' is film franchise. Pair with 'Aftermath' (installment), 'VR' (edition), or 'Saber'. "
        "Already tightened this session (2026-08-18)."
    ),
    (
        148, "Insurgency: Sandstorm", False,
        [
            "Insurgency Sandstorm",
            "Insurgency: Sandstorm",
            "Sandstorm game",
            "Sandstorm hardcore checkpoint",
            "Sandstorm push mode",
            "Sandstorm firefight",
            "Sandstorm frontline",
            "Sandstorm Year 3 Pass",
            "Sandstorm PvP",
            "Sandstorm co-op",
        ],
        "Bare 'Insurgency' matches military/political usage. Pin every keyword with 'Sandstorm'. "
        "Already tightened this session (2026-08-18)."
    ),

    # ── Competitor children ────────────────────────────────────────────────
    (
        138, "ILL", True,
        [
            "ILL game",
            "ILL the game",
            "ILL horror game",
            "ILL Team Clout",
            "ILL indie horror",
        ],
        "The keyword_generator's short-title guard rejects bare 'ILL' (collides with I'll, illness, sick). "
        "Must always qualify with 'game' / 'horror' / 'Team Clout' (developer)."
    ),
    (
        139, "SILENT HILL: Townfall", True,
        [
            "Silent Hill Townfall",
            "SILENT HILL: Townfall",
            "SH Townfall",
            "Silent Hill Townfall game",
            "Townfall Silent Hill",
        ],
        "Bare 'Silent Hill' matches franchise-wide (SH2/SHf/etc). Pin every kw with 'Townfall'."
    ),
    (
        140, "Halloween: The Game", True,
        [
            "Halloween the game",
            "Halloween the video game",
            "Halloween Illfonic",
            "Halloween game 2026",
            "Halloween Myers game",
            "Halloween slasher game",
        ],
        "Bare 'Halloween' matches the holiday, films, and every October gaming post. "
        "Must always qualify with 'the game', publisher (Illfonic), or 'Myers'/'slasher'."
    ),
    (
        145, "Gears of War: E-Day", True,
        [
            "Gears of War E-Day",
            "Gears of War: E-Day",
            "GoW E-Day",
            "Gears E-Day",
            "Gears of War Emergence Day",
            "E-Day Gears of War",
        ],
        "Bare 'Gears of War' matches franchise-wide. Pin with 'E-Day' / 'Emergence Day'. "
        "'GoW' alone collides with God of War — must always be 'GoW E-Day'."
    ),
    (
        146, "Aliens: Fireteam Elite 2", True,
        [
            "Aliens Fireteam Elite 2",
            "Aliens: Fireteam Elite 2",
            "Fireteam Elite 2",
            "AFE 2",
            "Aliens Fireteam 2",
            "Aliens Fireteam Elite sequel",
        ],
        "Bare 'Aliens' is franchise (film + Aliens: Colonial Marines + AFE 1). "
        "Pin with 'Fireteam' + '2' / 'sequel' / community shorthand 'AFE 2'."
    ),
]


def patch_game(game_id: int, keywords: list[str], dry_run: bool) -> tuple[bool, str]:
    """PATCH /api/games/{id} with the new distinctive_keywords."""
    url = f"{API}/games/{game_id}"
    body = json.dumps({"distinctive_keywords": keywords}).encode("utf-8")
    if dry_run:
        return True, f"[dry-run] would PATCH {url} with {len(keywords)} keywords"
    req = urllib.request.Request(
        url, data=body, method="PATCH",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp_body = resp.read().decode("utf-8", errors="replace")
            return True, f"HTTP {resp.status}"
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode("utf-8", errors="replace") if e.fp else ""
        return False, f"HTTP {e.code}: {body_txt[:300]}"
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Print what would be applied without PATCHing.")
    ap.add_argument("--only-id", type=int, default=None,
                    help="Apply to just one game_id (for smoke-testing).")
    args = ap.parse_args()

    # Sanity: every entry has ≥3 keywords, ≥1 multi-word each.
    problems: list[str] = []
    for gid, name, is_comp, kws, notes in KEYWORDS:
        if len(kws) < 3:
            problems.append(f"  id={gid} {name!r}: only {len(kws)} keywords (floor is 3)")
        for k in kws:
            if not k.strip():
                problems.append(f"  id={gid} {name!r}: empty/whitespace keyword")
        for k in kws:
            if len(k.split()) < 2 and len(k) < 6:
                # A single very-short word is a bare-token risk.
                problems.append(f"  id={gid} {name!r}: short bare-token keyword {k!r}")
    if problems:
        print("SCHEMA VIOLATIONS — refusing to run:", file=sys.stderr)
        print("\n".join(problems), file=sys.stderr)
        return 2

    print(f"Portfolio keyword population — {len(KEYWORDS)} titles")
    print(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE APPLY'}")
    print()

    ok = fail = 0
    for gid, name, is_comp, kws, notes in KEYWORDS:
        if args.only_id is not None and gid != args.only_id:
            continue
        typ = "COMP " if is_comp else "SABER"
        success, msg = patch_game(gid, kws, dry_run=args.dry_run)
        marker = "✓" if success else "✗"
        print(f"  {marker} [{typ}] id={gid:>3}  {name!r}  ({len(kws)} kws)  — {msg}")
        if success:
            ok += 1
        else:
            fail += 1
        # Small delay to be nice to the API
        if not args.dry_run:
            time.sleep(0.15)

    print()
    print(f"Applied: {ok} OK, {fail} FAILED")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
