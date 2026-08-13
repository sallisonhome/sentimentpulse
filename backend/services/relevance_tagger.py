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
    "nintendoswitch", "nintendo",
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
    "gamingcirclejerk",
    # Genre discussion
    "shootergames", "thirdpersonshooter", "fps", "coopgaming",
    "simracing", "simulators", "drivingsimulators",
    "gamingphotography", "gamingaccessibility",
    # Genre umbrellas (produce a lot of unrelated posts)
    "horror", "horrorgaming", "horrorgames",
    "survivalhorror", "residentevil",
    # IP-adjacent but broader than one game
    "hellraiser", "halo", "ghostbusters", "jurassicpark", "johnwick",
    # Publisher / dev / catalog subs
    "spacemarine", "saberinteractive", "bossteamgames",
    "gearsofwar", "xboxgamepass",
})

_SUB_RE = re.compile(r"/r/([^/]+)/", re.IGNORECASE)

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
