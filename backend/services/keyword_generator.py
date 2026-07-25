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

v2 (2026-07-24 evening) — hardened after the ILL/Townfall data-corruption
incident. Two new safety rules:

  * Short-single-word titles (≤3 chars, or a common English word like
    'ill', 'go', 'fez') NEVER emit a bare-title keyword. They MUST emit
    only qualified variants ('<title> game', '<title> horror game').
    The bare form was causing catastrophic false positives on the ILL
    game (matched every 'ill', "I'll", 'illness' occurrence). See
    lessons.md 2026-07-24 (evening).

  * Franchise-spin-off titles (title contains a colon separator) NEVER
    emit the bare main-title fragment as a keyword when the subtitle is
    itself a distinctive spin-off name. This prevents 'SILENT HILL:
    Townfall' from emitting bare 'SILENT HILL' (which matched all
    Silent Hill franchise noise across the SH2/SH3/SHf discussion
    threads). Instead the main-title fragment is combined with the
    subtitle to produce disambiguated variants only.
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

# Short-title collision list — words that as a standalone game title
# collide with common English usage (contractions, adjectives, prefixes,
# proper-noun homographs). For any of these OR any ≤3-char title, we
# refuse to emit the bare title as a keyword. See lessons.md 2026-07-24.
_UNSAFE_SHORT_TITLES = frozenset({
    # Contractions / adjectives / common prefixes
    "ill", "go", "fez", "hi", "in", "up", "we", "if", "do", "or",
    "ok", "no", "my", "me", "is", "am", "be", "to", "of", "on",
    # Common short words game titles have historically used unsafely
    "one", "two", "the", "and", "for", "pop", "top", "box", "day",
    "end", "war", "run", "fly", "win", "sit", "cat", "dog", "sea",
})

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

    # v2 short-title guard: for very short or common-word titles, refuse
    # to emit the bare title as a keyword. Only emit qualified forms.
    title_lower = title.lower()
    is_unsafe_short = (
        len(title) <= 3
        or title_lower in _UNSAFE_SHORT_TITLES
        or (" " not in title and len(title) <= 5 and title_lower.isalpha())
    )

    # 1. Full title, verbatim — ONLY for safe titles.
    if not is_unsafe_short:
        candidates.append(title)

    # 2. Title + "game" — always safe ("game" is the disambiguator).
    candidates.append(f"{title} game")

    # 2b. For unsafe short titles, add extra qualified variants so we
    # get to the caller's 3-keyword floor without emitting the bare form.
    if is_unsafe_short:
        candidates.append(f"{title} the game")
        # Only these two extra variants are safe generic disambiguators;
        # anything else ("<title> horror game") assumes genre we don't
        # know. Caller will still log a WARNING and expect manual review.

    # 3. Subtitle-only (if >= 2 words) + qualified main-title fragment.
    # v2: NEVER emit bare main-title fragment for spin-offs. If the
    # subtitle exists and is itself ≥1 word, combine main+sub into a
    # disambiguated form rather than emitting either bare.
    parts = _SEPARATOR_RE.split(title, maxsplit=1)
    if len(parts) == 2:
        main_part, subtitle = parts[0].strip(), parts[1].strip()
        if subtitle and len(subtitle.split()) >= 2:
            # Multi-word subtitle IS safe as a standalone keyword
            # (e.g. "The Road Ahead" for "A Quiet Place: The Road Ahead").
            candidates.append(subtitle)
        # v2: bare main_part is emitted only for ≥3-word main titles.
        # "SILENT HILL: Townfall" (2-word main) no longer emits bare
        # "SILENT HILL". "A Quiet Place: The Road Ahead" (3-word main)
        # still emits "A Quiet Place" — 3+ words are distinctive enough
        # not to collide with franchise noise.
        if main_part and len(main_part.split()) >= 3:
            candidates.append(main_part)
        if main_part and subtitle:
            # Combined form 1: "<main> <subtitle>" (space-normalized)
            combined = f"{main_part} {subtitle}".strip()
            if combined and combined.lower() != title.lower():
                candidates.append(combined)
            # Combined form 2: reversed — "<subtitle> <main>" — catches
            # community usage patterns like "Townfall Silent Hill".
            reversed_ = f"{subtitle} {main_part}".strip()
            if reversed_ and reversed_.lower() != combined.lower():
                candidates.append(reversed_)

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
