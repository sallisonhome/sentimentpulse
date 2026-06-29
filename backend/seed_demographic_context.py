"""§24 — Seed default demographic + IP-awareness briefs for the 8 priority titles.

These briefs tell the bold-ideas LLM what cohort the title needs to reach
and what the IP-awareness gap looks like.  Used together with editorial
research to ground speculative cohort-reach bold ideas (e.g. "reach the
<40 cohort that knows Pinhead imagery but not the franchise").

The user can override per title via PATCH /api/games/{id} demographic_context.

Run manually:
    python -m seed_demographic_context

Or via the maintenance endpoint:
    POST /api/games/seed-demographic-context
"""

from sqlalchemy.orm import Session

from database import SessionLocal
from models import Game


DEFAULTS: dict[int, str] = {
    21: (  # Clive Barker's Hellraiser: Revival
        "TARGET COHORTS:\n"
        " - Core (40+): horror fans who saw the original Hellraiser films "
        "in cinemas or on VHS; recognize Pinhead, the Cenobites, the puzzle "
        "box. High intent, low volume.  These are the people preordering "
        "the Collector's Edition.\n"
        " - Discovery cohort (18-35): grew up with horror movies but the "
        "Hellraiser franchise is pre-2000 and largely off their radar. "
        "Recognize Pinhead's silhouette and imagery (memes, Halloween "
        "costumes, references in modern horror) but have NOT seen the films "
        "and do NOT know the lore.  This cohort is the marketing barrier: "
        "the IP imagery is iconic but the franchise itself needs an entry "
        "point that doesn't require homework.\n"
        "IP AWARENESS GAP: For <35 audiences, Hellraiser is 'that movie "
        "with the nail head guy', not a known mythology.  Bold ideas that "
        "reach this cohort must onboard the lore (Cenobite mythology, "
        "puzzle-box mechanic, Clive Barker's auteur position in horror) "
        "via accessible formats -- short-form video, streamer playthroughs, "
        "auteur-interview content, cross-IP collabs with creators who "
        "already command the under-35 horror audience.\n"
        "REFERENCE PLAYS THAT WORKED FOR ADJACENT IPs: Resident Evil "
        "Requiem's Re:Verse short film series, Silent Hill 2 Remake's "
        "Bloober interview circuit, Stranger Things' multi-decade nostalgia "
        "play with younger viewers who never saw the source material."
    ),
    23: (  # Turok: Origins
        "TARGET COHORTS:\n"
        " - Core nostalgia cohort (35-50): played Turok: Dinosaur Hunter "
        "(N64, 1997), Turok 2: Seeds of Evil (1998), or Turok: Evolution.  "
        "Specific exotic-weapon memory anchors: CEREBRAL BORE, Tek Bow, "
        "Razor Wind, PFM Mines.  Dinosaur enemy variety is the affection "
        "object.  This cohort is small but extremely loyal -- they have "
        "been waiting 20+ years for a 'real' Turok comeback.\n"
        " - New cohort (18-30): no franchise memory.  Adjacent interests "
        "are dinosaur-action games (Ark, Path of Titans, Saurian) and "
        "retro-shooter revivals (DOOM 2016/Eternal, Quake remaster, "
        "Prodeus, Ultrakill).  May come to Turok if positioned as 'the "
        "dinosaur shooter the genre's been missing' alongside the "
        "boomer-shooter revival.\n"
        "IP AWARENESS GAP: For <30 audiences, Turok is a name, not a "
        "franchise.  Bold ideas should bridge the nostalgia cohort's "
        "weapon/dinosaur memory into modern positioning while building "
        "fresh awareness via dinosaur-genre adjacency.  Specifically: "
        "the Cerebral Bore is one of the most iconic 'remember this?' "
        "weapons in shooter history -- it is a marketing asset waiting "
        "to be activated for both cohorts.\n"
        "REFERENCE PLAYS: DOOM 2016's 'classic weapons remade' marketing, "
        "Metroid Dread's reveal of the morph-ball + grapple combo as "
        "fan service, Resident Evil 4 Remake's Leon character-design "
        "reverence."
    ),
    24: (  # Warhammer 40,000: Space Marine 2
        "TARGET COHORTS:\n"
        " - Tabletop / lore cohort (25-50): Warhammer 40K tabletop players, "
        "Black Library readers, miniature painters.  Deep faction knowledge "
        "(Tyranids, Black Templars, Salamanders).  Highly active in /r/Warhammer40k, "
        "Discord servers, Twitch.  Authenticity to Codex is the loyalty test.\n"
        " - Action co-op cohort (18-35): players who came in via Helldivers 2, "
        "Deep Rock Galactic, Vermintide.  Less tabletop knowledge; here for "
        "the squad-based PVE loop.  Sensitive to balance and post-launch "
        "content cadence.\n"
        "IP AWARENESS GAP: Lower than Hellraiser/Turok -- 40K is a global "
        "IP with Amazon TV adaptations in development and an aggressive "
        "cross-media push from Games Workshop.  The 'soft' barrier is "
        "depth-of-lore intimidation: new players know it's complex.  Bold "
        "ideas should bridge tabletop authenticity (Chapter Pack DLC, "
        "Codex-accurate cosmetics) into the action-co-op cohort via "
        "low-friction lore explainers.\n"
        "REFERENCE PLAYS: Helldivers 2's Major Order live narrative, "
        "Destiny's lore-book unlocks, Hunt: Showdown's faction reveals."
    ),
    25: (  # John Carpenter's Toxic Commando
        "TARGET COHORTS:\n"
        " - Carpenter / horror-fandom cohort (35-55): John Carpenter "
        "soundtrack devotees, fans of Escape from NY, The Thing, They "
        "Live, Big Trouble in Little China.  Recognize the synth-driven "
        "aesthetic; here for the auteur stamp.\n"
        " - L4D / co-op zombie cohort (18-35): Left 4 Dead 1/2, Back 4 "
        "Blood, World War Z players.  Less interested in Carpenter, more "
        "interested in vehicle/open-level co-op zombie gameplay.\n"
        "IP AWARENESS GAP: 'John Carpenter' as a personal brand is strong "
        "for 35+ but unknown to many <30 players.  Bold ideas should "
        "lean on Carpenter's musical signature (analog synth, the Carpenter "
        "soundtrack collaboration with Gunship) as a sensory differentiator "
        "rather than expecting players to recognize his filmography.\n"
        "REFERENCE PLAYS: Stranger Things' multi-generation nostalgia "
        "(younger viewers love the synth aesthetic without knowing the "
        "1980s source material), Hotline Miami's synthwave soundtrack "
        "carrying the brand."
    ),
    134: (  # Bus Bound
        "TARGET COHORTS:\n"
        " - Bus-sim core (30-60): Fernbus Simulator, OMSI players.  "
        "Authenticity-driven: real bus models (RIDE, BYD), accurate "
        "routes, realistic transmissions.  Welsh and other localizations "
        "are marquee features for this cohort.\n"
        " - Accessibility / casual sim cohort (18-40): players who like "
        "the IDEA of simulators but find Fernbus/OMSI intimidating.  Bus "
        "Bound's arcade-leaning balance is the on-ramp for this group.\n"
        "IP AWARENESS GAP: Indie title; awareness is the primary "
        "barrier.  Welsh VO and named voice talent (Jeff from Emberville) "
        "are organic PR hooks already working.  Bold ideas should expand "
        "the on-ramp positioning -- 'the bus sim that doesn't require "
        "a 200-page manual' -- and lean on partnerships (RIDE, regional "
        "transit operators) for cross-promotional reach."
    ),
    131: (  # HITMAN Classic Trilogy Remastered
        "TARGET COHORTS:\n"
        " - HITMAN classic cohort (30-55): played HITMAN: Codename 47, "
        "HITMAN 2: Silent Assassin, HITMAN Contracts.  Older, lapsed "
        "from the modern HITMAN World of Assassination but interested "
        "in the original level design + soundtrack (Jesper Kyd).\n"
        " - HITMAN World of Assassination cohort (20-40): currently "
        "playing the modern trilogy; cautiously interested in the "
        "classics for completion / canon.\n"
        "IP AWARENESS GAP: Modest -- Agent 47 is a recognizable silhouette "
        "across cohorts.  The classic-vs-modern divide is the marketing "
        "angle: bold ideas should differentiate the remaster from the "
        "modern trilogy on level design philosophy (deliberate, slower-"
        "paced, more puzzle-like vs the modern sandbox)."
    ),
    20: (  # Untitled John Wick Game
        "TARGET COHORTS:\n"
        " - John Wick film cohort (25-50): saw all four films, recognize "
        "the gun-fu style, the Continental, the High Table mythology.  "
        "Pre-existing affinity for the brand.\n"
        " - Action-shooter cohort (18-35): not necessarily film fans but "
        "interested in tactical / stylized gunplay (MAX PAYNE 3, SIFU, "
        "John Wick Hex).\n"
        "IP AWARENESS GAP: Low -- the film franchise is broadly known.  "
        "Risk is OVER-relying on film references vs delivering a "
        "differentiated gameplay loop.  Bold ideas should anchor on "
        "specific gun-fu mechanics or Continental-mythology systems, "
        "not just film cameos."
    ),
    130: (  # Stuntman: Hollywood
        "TARGET COHORTS:\n"
        " - Stuntman nostalgia cohort (35-50): played Stuntman (PS2 2002) "
        "and Stuntman: Ignition (PS3/360 2007); remember the precision-"
        "stunt-sequence gameplay and the punishing difficulty.\n"
        " - Cinematic-driving cohort (20-40): players who came to the "
        "genre via Need for Speed Movie tie-ins, Forza Horizon's stunt "
        "showcases, or content creators like Hoonigan.\n"
        "IP AWARENESS GAP: Stuntman is a dormant brand -- the franchise "
        "has been silent for ~18 years.  Awareness is the primary "
        "marketing barrier.  Bold ideas should bridge stunt-driving "
        "social-media culture (Hoonigan, Travis Pastrana, modern stunt "
        "shows) into the gameplay's precision-stunt identity."
    ),
}


def seed_default_demographic_context(db: Session, overwrite: bool = False) -> dict:
    """Seed defaults for the 8 priority titles.

    Args:
        overwrite: when False (default), only sets context for titles
            whose demographic_context is currently NULL.  When True,
            overwrites existing values.

    Returns: {"seeded": N, "skipped_existing": M}
    """
    seeded = 0
    skipped = 0
    for game_id, brief in DEFAULTS.items():
        game = db.query(Game).filter_by(id=game_id).first()
        if game is None:
            continue
        if game.demographic_context and not overwrite:
            skipped += 1
            continue
        game.demographic_context = brief
        seeded += 1
    db.commit()
    return {"seeded": seeded, "skipped_existing": skipped}


if __name__ == "__main__":
    with SessionLocal() as session:
        result = seed_default_demographic_context(session, overwrite=False)
        print(f"Seeded demographic_context for {result['seeded']} titles "
              f"(skipped {result['skipped_existing']} existing).")
