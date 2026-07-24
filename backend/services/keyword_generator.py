"""
Heuristic default-keyword generator for newly-created games.

Mirrors the manual process used to build the initial `distinctive_keywords`
proposal for the 29 pre-existing games (see
`/home/user/workspace/sentiment_relevance_fix/proposed_keywords.md`), as a
reusable function so that POST /api/games auto-populates a safe, non-empty
baseline for any NEW game instead of leaving `distinctive_keywords` empty
(which, as of the 2026-07-24 relevance-gate change, means the game is
gated OUT of sentiment classification entirely — see
`services/post_relevance.py`).

Deliberately conservative: title-derived variants only. Does NOT attempt to
invent studio nicknames or IP shorthand (e.g. "Saber Turok", "SM2") — that
requires human judgment about community slang and is intentionally left for
manual review. A WARNING is logged by the caller (routers/games.py) when
fewer than 3 keywords come out, which is the signal for a human to add
nickname-level keywords the same way the initial 29-game review pass did.
"""
from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

# Signals that a title is a remaster/reboot/re-release — worth tagging with
# the current year, since community discussion often qualifies these titles
# with a year to disambiguate from the original release.
_REMASTER_SIGNAL_RE = re.compile(
    r"\b(remaster(?:ed)?|remake|revival|origins?|anniversary)\b",
    re.IGNORECASE,
)

# Trademark / registration glyphs to strip from every generated keyword.
_TRADEMARK_GLYPHS_RE = re.compile(r"[™®©]")

# Splits a title into "main title" / "subtitle" on the first colon or
# em/en-dash / hyphen-surrounded-by-spaces separator.
_SEPARATOR_RE = re.compile(r"\s*[:\u2013\u2014]\s*|\s+-\s+")


def _strip_trademark(text: str) -> str:
    return _TRADEMARK_GLYPHS_RE.sub("", text).strip()


def _dedupe_preserve_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        key = item.lower().strip()
        if key and key not in seen:
            seen.add(key)
            out.append(item.strip())
    return out


def generate_default_keywords(title: str, current_year: int | None = None) -> list[str]:
    """
    Heuristic keyword generator — mirrors the manual process used to build
    the initial distinctive_keywords proposal.

    Produces up to 5 candidates:
      1. Full title, verbatim (trademark glyphs stripped).
      2. Title + "game" (disambiguates from IP/movie/common-word titles).
      3. Subtitle-only, if the title has a ":" / "-" separator AND the
         subtitle alone is >= 2 words (avoids single-word subtitle
         collisions with common English words).
      4. Title with punctuation removed / colon replaced by nothing
         (catches "JP:Survival"-style compressed community shorthand).
      5. Title + current year, if the title contains "Remastered", "Remake",
         "Revival", "Origins", or "Anniversary" (remaster/reboot signal).

    Returns an empty list if `title` is empty/whitespace-only (caller should
    log a WARNING in that case — this function does not raise).
    """
    if not title or not title.strip():
        return []

    title = _strip_trademark(title.strip())
    if not title:
        return []

    candidates: list[str] = []

    # 1. Full title, verbatim.
    candidates.append(title)

    # 2. Title + "game".
    candidates.append(f"{title} game")

    # 3. Subtitle-only (if >= 2 words).
    parts = _SEPARATOR_RE.split(title, maxsplit=1)
    if len(parts) == 2:
        main_part, subtitle = parts[0].strip(), parts[1].strip()
        if subtitle and len(subtitle.split()) >= 2:
            candidates.append(subtitle)
        if main_part and len(main_part.split()) >= 2:
            # Keep the qualified main-title fragment too — e.g. for
            # "A Quiet Place: The Road Ahead" this yields "A Quiet Place".
            # Only kept if it's still multi-word (avoids re-adding a single
            # common word bare).
            candidates.append(main_part)

    # 4. Punctuation-stripped compressed form (colon/hyphen removed, no
    #    extra whitespace) — catches "JP:Survival"-style shorthand typed
    #    without spaces around the separator.
    compressed = _SEPARATOR_RE.sub(" ", title)
    compressed = re.sub(r"[^\w\s]", "", compressed)
    compressed = re.sub(r"\s+", " ", compressed).strip()
    if compressed and compressed.lower() != title.lower():
        candidates.append(compressed)

    # 5. Title + current year, only for remaster/reboot signal titles.
    if _REMASTER_SIGNAL_RE.search(title):
        import datetime

        year = current_year or datetime.date.today().year
        candidates.append(f"{title} {year}")

    deduped = _dedupe_preserve_order(candidates)
    return deduped[:5]
