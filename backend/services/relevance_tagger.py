"""Relevance tagger (v3, 2026-08-12)

Assigns raw_posts.relevance_tier and raw_posts.matched_keywords based on:
  1. Whether the post came from a "dedicated" source (game-specific
     subreddit, or a Bluesky search that already required the game name
     to hit) — those get 'dedicated_sub' with no keyword check.
  2. Whether the post text contains any of the game's distinctive keywords
     for broader sources.

Never drops posts. Analytics/spike-detection reads only relevance_tier IN
('dedicated_sub', 'signal').

Design goals:
- Idempotent: running the tagger twice on the same post produces the same
  verdict, so the retroactive backfill and per-ingest tagging can share
  code paths.
- Configurable per-game via games.distinctive_keywords when set; otherwise
  falls back to a keyword list derived from the game name.
- Cheap: a single pass over each post's title+body with a simple keyword
  scan. No LLM calls, no regex compilation per post.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional

from models import RawPost, Game, SourceEnum


# ── Dedicated-source rules ───────────────────────────────────────────────

# Subreddits considered "general" — posts from these must match keywords
# to be tagged as signal. Anything not in this list is treated as a
# dedicated sub. Mirrors ARCTIC_SHIFT_GENERAL_SUBS but wider — spike
# analytics need MORE noise flagged than the fetcher does.
#
# Case-insensitive match against the subreddit name extracted from the URL.
GENERAL_SUBS: frozenset[str] = frozenset({
    # Platform / console
    "gaming", "games", "pcgaming", "pcmasterrace", "ps5", "playstation",
    "xbox", "xboxseriesx", "xboxone", "steam", "steamdeck",
    "nintendoswitch", "nintendo", "switch2", "videogames",
    # Discovery / discussion
    "patientgamers", "shouldibuythisgame", "truegaming",
    "gamedeals", "lowspecgamer", "gamingsuggestions",
    # News/leaks
    # v0016.9 (2026-08-12): British/US 'u' spelling. The actual subreddit is
    # r/GamingLeaksAndRumours (with 'u'). Without both spellings in the set,
    # r/GamingLeaksAndRumours posts get tagged as dedicated_sub for whichever
    # game happens to fetch them first — polluting priority games' data with
    # unrelated gaming news (Elder Scrolls, etc).
    "gamingleaksandrumors", "gamingleaksandrumours", "gamingnews",
    "gamingcirclejerk", "gamepreservation", "gamecollecting",
    # Genre discussion
    "shootergames", "thirdpersonshooter", "fps", "coopgaming",
    "simracing", "simulators", "drivingsimulators", "racinggames",
    "gamingphotography", "gamingaccessibility",
    "acgvids", "retrogaming",
    # Genre umbrellas (produce a lot of unrelated posts)
    "horror", "horrorgaming", "horrorgames",
    "survivalhorror", "residentevil", "alienisolation",
    "outlast", "amnesiathegame",
    # IP-adjacent but broader than one game
    "hellraiser", "halo", "ghostbusters", "jurassicpark", "johnwick",
    "jurassicworld", "jurassicmemes", "jurassicworldevo",
    "jurassicworldevol2", "jurassicworldalive",
    "clivebarker", "cenobites", "hellraiserthegame",
    # Publisher / dev / catalog subs — posts here are often about the studio
    # or an unrelated title in their catalog, not the focal game.
    "spacemarine", "saberinteractive", "bossteamgames",
    "gearsofwar", "xboxgamepass", "lionsgate", "worldwarzthegame",
    # (2026-08-17) Focus Entertainment publisher sub — carries WWZ AND
    # Insurgency: Sandstorm announcements plus a large catalog of unrelated
    # titles (Warhammer, Aliens Dark Descent, Atomfall, GreedFall, etc.).
    # Must be keyword-gated so unrelated Focus catalog posts don't get tagged
    # dedicated_sub for whichever Focus-published game happens to fetch first.
    "focusentertainment",
    # (2026-08-17) VR platform umbrellas — WWZ VR shipped Aug 2025 and its
    # config includes these subs, but they carry every VR game's content.
    # Keyword-gate so only actual WWZ VR posts get tagged for WWZ.
    "virtualreality", "vrgaming", "oculusquest", "metaquestvr",
    # (2026-08-17) Ready or Not / Squad / Arma / Ground Branch / HLL / RS2 /
    # Harsh Doorstop / Six Days in Fallujah / Tarkov / Delta Force — all are
    # tactical-shooter competitors of Insurgency: Sandstorm. If added to an
    # Insurgency subreddit config without keyword-gating, every submission on
    # their own games would be tagged dedicated_sub for Insurgency — same bug
    # as the Turok/Helldivers issue on 2026-08-14. MilSim + Battlefield/CoD
    # families included for the same reason.
    "playsquad", "joinsquad",
    "arma", "arma3", "armareforger",
    "readyornotgame",
    "groundbranch",
    "helletloose", "hellletloose",
    "rs2vietnam", "risingstorm2",
    "harshdoorstop",
    "sixdaysinfallujah",
    "escapefromtarkov", "tarkov",
    "deltaforcegamehq", "deltaforce", "deltaforceglobal",
    "milsim",
    "battlefield", "battlefield6", "battlefieldv", "battlefield2042",
    "callofduty", "modernwarfareiii", "modernwarfareii",
    # Zombie / co-op-shooter neighbors already covered elsewhere; adding the
    # remaining canonical subs so WWZ can't inherit their content.
    "back4blood", "l4d2", "left4dead", "killingfloor", "killingfloor2",
    "vermintide", "paydaytheheist", "payday", "paydaythegame",
    "zombies", "codzombies", "postapocalyptic",
    # Competitor / adjacent-genre game subs — these show up in per-game
    # subreddit configs to catch cross-title discussion but produce huge
    # volumes of on-title-for-that-competitor content that must NOT be
    # inherited into the focal game's dedicated_sub bucket.
    # (2026-08-14) Added after tracing that Turok's config included r/Helldivers,
    # r/DeepRockGalactic, r/DarkTide, etc. and every submission from those
    # subs was being tagged dedicated_sub for Turok without any keyword check.
    "helldivers", "lowsodiumhelldivers", "darktide", "deeprockgalactic",
    "hitman", "sifu", "maxpayne", "actionmovies", "movies",
    "burnout", "builtfromthegroundup", "splitsecond", "flatout",
    "wreckfest", "needforspeed", "forza", "forzahorizon", "the_crew",
    "cars", "carporn", "musclecar", "fastandfurious",
    "backtothefuture", "knightrider", "miamivice", "universalstudios",
    "psvr", "gta", "ps2", "nostalgia",
    "dinosaurs", "paleontology", "naturewasmetal", "galapagos",
    "primalcarnage", "theisle", "pathoftitans", "ark", "playark",
    "scifi", "indigenousgaming", "n64",
})

_SUB_RE = re.compile(r"/r/([^/]+)/", re.IGNORECASE)

# Per-subreddit "dominant-topic" keywords. When a Reddit submission comes
# from one of these subs AND its title+body contains 2+ hits on the sub's
# own dominant keywords, the post is a conversation about *that* sub's
# game and does NOT tag as signal for the focal game even if the focal
# game's keyword also appears somewhere in the text.
#
# Purpose: catches the case where a competitor-sub submission legitimately
# name-drops the focal game (e.g. "Turok 3 was better than Helldivers ever
# will be" posted in r/Helldivers). Without this gate the focal game gets
# a false-positive dedicated_sub tag and the whole thread's comments
# inherit it.
#
# Keys must be lowercase subreddit names. Values are lowercase distinctive
# tokens/phrases that only appear when the sub's own game is the actual
# subject.
DOMINANT_TOPIC_KEYWORDS: dict[str, frozenset[str]] = {
    "helldivers": frozenset({
        "helldiver", "helldivers", "super earth", "stratagem", "stratagems",
        "managed democracy", "terminid", "automaton", "illuminate",
        "seaf", "major order", "warbond", "eagle strike", "orbital strike",
        "cape", "democracy officer", "liber-tea", "malevelon creek",
        "buffdivers", "nerfdivers", "arrowhead", "joel", "pilestedt",
    }),
    "lowsodiumhelldivers": frozenset({
        "helldiver", "helldivers", "super earth", "stratagem",
        "managed democracy", "terminid", "automaton", "illuminate",
        "seaf", "major order", "warbond", "arrowhead",
    }),
    "deeprockgalactic": frozenset({
        "rock and stone", "karl", "driller", "gunner", "scout", "engineer",
        "bosco", "molly", "hoxxes", "deep dive", "greenbeard", "leaflover",
        "m1000", "lithophage", "glyphid",
    }),
    "darktide": frozenset({
        "darktide", "tertium", "psyker", "ogryn", "zealot", "veteran",
        "fatshark", "warhammer 40k", "chaos", "hive city", "chained bolter",
    }),
    "spacemarine": frozenset({
        "space marine 2", "sm2", "titus", "gadriel", "chairon", "tyranid",
        "thousand sons", "leandros", "decimus", "astartes", "battle brother",
    }),
    "worldwarzthegame": frozenset({
        # Core franchise tokens
        "world war z", "wwz", "zeke", "lobo", "the swarm", "jerusalem",
        # (2026-08-17) Expanded coverage: characters, factions, class names,
        # mission/location tokens, and mode names distinctive to WWZ so posts
        # that name-drop competitors (Helldivers, L4D, Back 4 Blood) don't
        # false-tag as WWZ conversation. Note: 'hellraiser' is intentionally
        # excluded — it collides with the Hellraiser IP.
        "doyle", "mancini", "rothman", "kelly", "tanaka",
        "raven rock", "zero-day", "zero day",
        "bull zombie", "bull", "screamer", "lurker", "bomber",
        "gunslinger class", "slasher class", "medic class", "exterminator",
        "dronemaster", "vanguard class",
        "aftermath", "horde mode xl", "horde mode",
        "wwz aftermath", "gotr",
        # WWZ VR (shipped Aug 2025)
        "wwz vr", "world war z vr",
    }),
    "burnout": frozenset({
        "burnout paradise", "burnout 3", "burnout revenge", "criterion",
        "paradise city", "showtime", "crashbreaker", "aftertouch",
    }),
    "needforspeed": frozenset({
        "need for speed", "nfs unbound", "nfs heat", "nfs payback",
        "criterion", "ghost games", "blackbox", "underground 2",
    }),
    "forza": frozenset({
        "forza horizon", "forza motorsport", "playground games", "turn 10",
        "forzathon", "eventlab",
    }),
    "forzahorizon": frozenset({
        "forza horizon", "playground games", "forzathon", "eventlab",
        "horizon 5", "horizon 4",
    }),
    "the_crew": frozenset({
        "crew motorfest", "the crew 2", "ivory tower", "summit", "hyperbike",
    }),
    "wreckfest": frozenset({
        "wreckfest", "bugbear", "flatout", "destruction derby",
    }),
    "hitman": frozenset({
        "hitman 3", "hitman freelancer", "agent 47", "ioi", "io interactive",
        "world of assassination", "paris sanguine", "sapienza", "berlin",
        "mendoza", "dartmoor", "providence",
    }),
    "maxpayne": frozenset({
        "max payne 3", "max payne 2", "bullet time", "remedy", "rockstar toronto",
        "mona sax", "vinnie gognitti",
    }),
    "sifu": frozenset({
        "sifu", "sloclap", "pak mei", "kuroki", "sean", "jinfeng",
        "kung fu",
    }),
    "johnwick": frozenset({
        "chapter 4", "chapter 3", "chapter 2", "donnie yen", "caine",
        "marquis", "osaka continental", "bowery king", "charon", "winston",
    }),
    # Add other adjacent subs as needed. Only add subs whose dominant
    # game/franchise is DIFFERENT from any Saber portfolio game.
}

_STOP_WORDS: frozenset[str] = frozenset({
    "the", "and", "for", "with", "from", "this", "that", "have",
    "game", "games", "just", "your", "more", "about", "like",
    "revival",  # too generic for standalone "Revival" match
})


def _extract_subreddit(url: Optional[str]) -> Optional[str]:
    """Return the lowercased subreddit name from a Reddit URL, or None."""
    if not url:
        return None
    m = _SUB_RE.search(url)
    return m.group(1).lower() if m else None


def build_keywords_for_game(game: Game) -> list[str]:
    """
    Return the list of keywords that count as a "signal" match for this game.

    Priority order:
      1. games.distinctive_keywords when set (curated per-game list).
      2. Derived from game.name: words that are >=4 chars and not stopwords,
         plus the full title lowercased for exact-substring match.
    """
    if getattr(game, "distinctive_keywords", None):
        kws = [
            k.strip().lower()
            for k in game.distinctive_keywords
            if k and isinstance(k, str) and k.strip()
        ]
        if kws:
            return kws

    # Derive from title. Strip possessive prefixes ("Clive Barker's Hellraiser
    # ..." → "Hellraiser ...") so we don't tag every Clive-Barker novel
    # discussion as signal.
    name = game.name
    if "'s " in name:
        name = name.split("'s ", 1)[1]

    words = [
        w.strip("':,-.!?()[]").lower()
        for w in name.split()
    ]
    kws = [w for w in words if len(w) >= 4 and w not in _STOP_WORDS]

    # Always include the raw stripped name as an exact-match candidate
    # (handles multi-word game titles like "Bus Bound" that might not
    # each survive the stop-word filter individually).
    stripped_lower = name.strip().lower()
    if stripped_lower and stripped_lower not in kws:
        kws.append(stripped_lower)
    return kws


def tag_post(
    *,
    source: SourceEnum,
    url: Optional[str],
    title: Optional[str],
    body: Optional[str],
    keywords: Iterable[str],
) -> tuple[str, list[str]]:
    """
    Classify a single post into (relevance_tier, matched_keywords).

    Rules:
      * source == 'bluesky': always 'signal' with matched keywords (search
        API already requires game-name terms, so every returned post is
        by definition on-topic).
      * source == 'dtf': treat like bluesky (targeted queries only).
      * source == 'steam_review' / 'steam_forum': always 'dedicated_sub'
        (the source scope IS the game itself — posts are attached to a
        specific appid, no cross-contamination possible).
      * source == 'reddit' + subreddit in GENERAL_SUBS: keyword-gated.
        Match → 'signal', no match → 'noise'.
      * source == 'reddit' + any other subreddit: 'dedicated_sub' (still
        record matched_keywords when any keyword happens to match).
    """
    keywords_list = [k for k in keywords if k]
    # v3.1 (2026-08-12): punctuation-normalize both keyword and text before
    # substring match so keywords like 'hellraiser revival' correctly match
    # post titles like 'Hellraiser: Revival Gameplay'. Collapse any run of
    # punctuation/whitespace into a single space. Without this, colons,
    # dashes, em-dashes and slashes silently prevent matches on subtitled
    # game names — the exact failure mode that caused the r/PS5 Hellraiser
    # Revival 14-minute preview thread (2026-08-10) to sit in 'noise' tier.
    def _normalize(s: str) -> str:
        # Replace anything that's not a letter/digit with a single space,
        # then collapse whitespace. Cheap alternative to regex import overhead.
        out = []
        prev_space = False
        for ch in s.lower():
            if ch.isalnum():
                out.append(ch)
                prev_space = False
            else:
                if not prev_space:
                    out.append(" ")
                prev_space = True
        return "".join(out).strip()

    text_raw = ((title or "") + " " + (body or "")).lower()
    text_norm = _normalize(text_raw)
    # Match against BOTH the raw lowercased text and the normalized text,
    # so a keyword that legitimately contains punctuation (e.g. 'hellraiser:revival'
    # from the seeded list) still matches when the text has it verbatim.
    matched = []
    for k in keywords_list:
        k_norm = _normalize(k)
        if k in text_raw or (k_norm and k_norm in text_norm):
            matched.append(k)

    # Steam surface: source is per-appid, so always dedicated.
    if source in (SourceEnum.steam_review, SourceEnum.steam_forum):
        return "dedicated_sub", matched

    # Bluesky / DTF: targeted queries.
    if source == SourceEnum.bluesky or source == SourceEnum.dtf:
        # If keywords matched, tag as signal with the matches. If none
        # matched but the source query hit anyway, still tag signal —
        # search returned it for a reason (title/body contained something
        # the search recognized).
        return "signal", matched

    # Reddit: check subreddit.
    if source == SourceEnum.reddit:
        sub = _extract_subreddit(url)
        if sub and sub in GENERAL_SUBS:
            if matched:
                # Dominant-topic gate: if the post primarily discusses the
                # subreddit's OWN game (2+ competitor-topic hits), a passing
                # mention of the focal game is not enough to admit it.
                # Prevents "Turok 3 was better than Helldivers" posted in
                # r/Helldivers from admitting the whole Helldivers thread
                # onto Turok's page.
                if sub in DOMINANT_TOPIC_KEYWORDS:
                    dom_kws = DOMINANT_TOPIC_KEYWORDS[sub]
                    dom_hits = sum(1 for k in dom_kws if k in text_raw)
                    if dom_hits >= 2:
                        return "noise", []
                return "signal", matched
            return "noise", []
        # Any non-general sub: dedicated. Still record matches (informational).
        return "dedicated_sub", matched

    # Unknown source: unclassified.
    return "unclassified", matched


def analytics_filter_predicate():
    """
    Convenience: return the SQLAlchemy filter expression that selects
    only signal posts (either dedicated-sub or keyword-matched).

    Usage:
        q.filter(analytics_filter_predicate())
    """
    return RawPost.relevance_tier.in_(("dedicated_sub", "signal"))
