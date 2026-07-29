"""
§18 Sentiment Trust Chain — signal-volume gate (Layer 1), language gate (Layer 5),
title/body separation (Layer 2), and confidence floor (Layer 3).

PR #9 implemented Layers 1 + 5.
PR #10 adds Layers 2 + 3 (this file is extended here).
Layer 4 (lexicon overlay) is PR #11.

Public API
----------
count_substantive_tokens(text)         -> int
detect_language(text)                  -> str   (ISO 639-1 or 'und')
apply_signal_and_language_gate(...)    -> tuple[str, float, str]
is_rhetorical_question(title, body)    -> bool
combine_title_body(...)                -> tuple[str, float, bool]
apply_confidence_floor(...)            -> tuple[str, float, str | None, float | None]
"""
import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

# ── langdetect — make it deterministic ────────────────────────────────────────
try:
    from langdetect import detect as _ld_detect
    from langdetect import DetectorFactory
    from langdetect.lang_detect_exception import LangDetectException

    DetectorFactory.seed = 0   # deterministic results across runs
    _LANGDETECT_AVAILABLE = True
except ImportError:  # pragma: no cover — only happens if dep is missing
    _LANGDETECT_AVAILABLE = False
    logger.warning(
        "langdetect not installed — detect_language() will always return 'und'. "
        "Add langdetect==1.0.9 to requirements.txt."
    )


# ── NLTK English stopwords ─────────────────────────────────────────────────────
# We load them lazily once and cache in a module-level set.
_STOPWORDS: Optional[frozenset] = None


def _get_stopwords() -> frozenset:
    """Return cached NLTK English stopword set, loading on first call."""
    global _STOPWORDS
    if _STOPWORDS is not None:
        return _STOPWORDS

    try:
        from nltk.corpus import stopwords as _sw
        _STOPWORDS = frozenset(_sw.words("english"))
    except LookupError:
        # NLTK corpus not downloaded — download it now
        try:
            import nltk
            nltk.download("stopwords", quiet=True)
            from nltk.corpus import stopwords as _sw
            _STOPWORDS = frozenset(_sw.words("english"))
        except Exception as exc:
            logger.warning(
                "Could not load NLTK stopwords (%s). "
                "Falling back to minimal built-in list.", exc
            )
            _STOPWORDS = frozenset(_MINIMAL_STOPWORDS)

    return _STOPWORDS


# Minimal English stopword fallback (subset of NLTK list) — used only when
# NLTK corpus is unavailable at runtime.
_MINIMAL_STOPWORDS = frozenset({
    "i", "me", "my", "myself", "we", "our", "ours", "ourselves", "you",
    "your", "yours", "yourself", "yourselves", "he", "him", "his", "himself",
    "she", "her", "hers", "herself", "it", "its", "itself", "they", "them",
    "their", "theirs", "themselves", "what", "which", "who", "whom", "this",
    "that", "these", "those", "am", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "having", "do", "does", "did", "doing",
    "a", "an", "the", "and", "but", "if", "or", "because", "as", "until",
    "while", "of", "at", "by", "for", "with", "about", "against", "between",
    "into", "through", "during", "before", "after", "above", "below", "to",
    "from", "up", "down", "in", "out", "on", "off", "over", "under", "again",
    "further", "then", "once", "here", "there", "when", "where", "why", "how",
    "all", "both", "each", "few", "more", "most", "other", "some", "such",
    "no", "not", "only", "same", "so", "than", "too", "very", "s", "t",
    "can", "will", "just", "don", "should", "now", "d", "ll", "m", "o",
    "re", "ve", "y", "ain", "aren", "couldn", "didn", "doesn", "hadn",
    "hasn", "haven", "isn", "ma", "mightn", "mustn", "needn", "shan",
    "shouldn", "wasn", "weren", "won", "wouldn",
})

# ── Regex helpers ──────────────────────────────────────────────────────────────

# Matches ASCII letters only (a-zA-Z) — intentionally excludes Cyrillic and
# other Unicode alphabetic characters so the stopword list (English-only) is
# meaningful.  This is the conservative choice documented in CLAUDE.md §18:
# "use [a-zA-Z]+ regex match for substantive tokens since stopword list is English."
_ASCII_WORD_RE = re.compile(r"[a-zA-Z]+")

# Strip URLs before tokenising so "https://example.com" doesn't contribute tokens
_URL_RE = re.compile(
    r"https?://\S+|www\.\S+",
    re.IGNORECASE,
)


# ── Public API ────────────────────────────────────────────────────────────────

def count_substantive_tokens(text: str) -> int:
    """
    Count substantive English tokens in *text*.

    Algorithm
    ---------
    1. Remove URLs.
    2. Extract ASCII-letter sequences (a-zA-Z only) — ignores Cyrillic and
       other non-ASCII alphabetic scripts because the stopword list is English.
    3. Lowercase every token.
    4. Remove English stopwords (NLTK list, falling back to a built-in subset).
    5. Keep tokens with length ≥ 3.

    Returns the count of surviving tokens.

    Design note — Cyrillic / non-Latin scripts
    -------------------------------------------
    Python's str.isalpha() returns True for Cyrillic letters, so a naïve
    `.isalpha()` check would incorrectly count Russian words as "substantive"
    even though they would never match the English stopword list and the model
    is English-only.  We use `[a-zA-Z]+` regex to stay consistent with the
    language assumption.
    """
    if not text:
        return 0

    # Step 1 — remove URLs
    cleaned = _URL_RE.sub(" ", text)

    # Step 2 — extract ASCII letter sequences
    words = _ASCII_WORD_RE.findall(cleaned)

    # Step 3+4+5 — lowercase, remove stopwords, keep ≥3 chars
    stopwords = _get_stopwords()
    count = 0
    for word in words:
        word_lower = word.lower()
        if len(word_lower) >= 3 and word_lower not in stopwords:
            count += 1

    return count


def detect_language(text: str) -> str:
    """
    Detect the primary language of *text*.

    Returns an ISO 639-1 code (e.g. 'en', 'ru', 'es') or 'und' when:
    - text is empty / whitespace-only
    - text is too short for reliable detection
    - langdetect raises LangDetectException (ambiguous input)
    - langdetect is not installed

    Deterministic: DetectorFactory.seed = 0 is set at module import.
    """
    if not _LANGDETECT_AVAILABLE:
        return "und"

    if not text or not text.strip():
        return "und"

    try:
        result = _ld_detect(text.strip())
        return result if result else "und"
    except LangDetectException:
        return "und"
    except Exception as exc:
        logger.warning("detect_language: unexpected error (%s) — returning 'und'", exc)
        return "und"


def apply_signal_and_language_gate(
    text: str,
    raw_label: str,
    raw_score: float,
    language: str,
) -> tuple[str, float, str]:
    """
    Apply §18 Layer 1 (signal-volume gate) and Layer 5 (language gate).

    Parameters
    ----------
    text       : The post text (title + body) that was classified.
    raw_label  : The model's raw sentiment label ('positive'|'negative'|'neutral').
    raw_score  : The model's raw confidence score [0, 1].
    language   : ISO 639-1 language code returned by detect_language().

    Returns
    -------
    (final_label, final_score, signal_quality) where:
        final_label    — adjusted label after applying gates
        final_score    — adjusted score after applying gates
        signal_quality — 'low' | 'medium' | 'high'

    Gate logic (applied in order)
    ------------------------------
    1. Classify signal volume:
       - 0–2 substantive tokens → signal_quality = 'low'
       - 3–6 substantive tokens → signal_quality = 'medium'
       - 7+  substantive tokens → signal_quality = 'high'

    2. Language gate (Layer 5 — outermost guard):
       - Non-English (language != 'en') → ('neutral', 0.5, signal_quality)
         Fires regardless of signal quality.

    3. Signal-volume gate (Layer 1):
       - 'low'    → ('neutral', 0.5, 'low')
       - 'medium' → (raw_label, min(raw_score, 0.6), 'medium')
       - 'high'   → (raw_label, raw_score, 'high')
    """
    token_count = count_substantive_tokens(text)

    # Determine signal quality
    # 2026-07-29: low-threshold driven by settings.sentiment_low_signal_max_tokens
    # (was hardcoded 2). Lowering to 1 lets clear-signal 2-token posts
    # ("great trailer") flow through classification instead of auto-neutral.
    from config import settings as _s  # noqa: PLC0415
    if token_count <= _s.sentiment_low_signal_max_tokens:
        signal_quality = "low"
    elif token_count <= 6:
        signal_quality = "medium"
    else:
        signal_quality = "high"

    # Layer 5 — language gate (fires before signal gate)
    if language != "en":
        return ("neutral", 0.5, signal_quality)

    # Layer 1 — signal-volume gate
    if signal_quality == "low":
        return ("neutral", 0.5, "low")

    if signal_quality == "medium":
        # Cap driven by settings.sentiment_medium_signal_cap (2026-07-29).
        # Was hardcoded 0.6, which automatically flunked the 0.70 floor.
        # New default 0.68 clears the new 0.55 floor with room to spare.
        from config import settings  # noqa: PLC0415
        return (raw_label, min(raw_score, settings.sentiment_medium_signal_cap), "medium")

    # signal_quality == "high"
    return (raw_label, raw_score, "high")


# ── §18 Layer 2: Title vs body separation ─────────────────────────────────────

def is_rhetorical_question(title: str, body: str) -> bool:
    """
    Return True iff the title ends with '?' AND the body has ≥ 100 characters.

    This signals a rhetorical question post (e.g. "Did they break more than they
    fixed?") where the body contains the real sentiment signal and the title's
    question mark should not trigger a conflict flag.

    Parameters
    ----------
    title : str  — the post title (may be empty)
    body  : str  — the post body  (may be empty)
    """
    return title.strip().endswith("?") and len(body) >= 100


def combine_title_body(
    title_label: str,
    title_score: float,
    body_label: str,
    body_score: float,
    title: str,
    body: str,
) -> tuple[str, float, bool]:
    """
    Combine independent title and body classifications per §18 rule 3.

    Parameters
    ----------
    title_label  : model label for the title text
    title_score  : model confidence for the title text
    body_label   : model label for the body text
    body_score   : model confidence for the body text
    title        : raw title string (used for rhetorical detection)
    body         : raw body string  (used for rhetorical detection)

    Returns
    -------
    (final_label, final_score, sentiment_conflict) where:
        final_label       — the winning label
        final_score       — the final confidence score
        sentiment_conflict— True when labels disagreed with no rhetorical signal

    Rules (applied in order)
    ------------------------
    1. Labels match → (same_label, min(title_score, body_score), False)
    2. Labels disagree AND rhetorical question → (body_label, body_score, False)
       Body wins; no conflict flag because the rhetorical signal is intentional.
    3. Labels disagree, no rhetorical signal → (body_label, min(body_score, 0.65), True)
       Body wins (longer / richer signal); score capped at 0.65; conflict flagged.
    """
    if title_label == body_label:
        return (title_label, min(title_score, body_score), False)

    # Labels disagree — check for rhetorical question
    if is_rhetorical_question(title, body):
        return (body_label, body_score, False)

    # Labels disagree, no rhetorical signal — body wins, capped score, conflict
    return (body_label, min(body_score, 0.65), True)


# ── §18 Layer 3: Confidence floor — strict 0.70 ───────────────────────────────

def apply_confidence_floor(
    label: str,
    score: float,
    threshold: float | None = None,
) -> tuple[str, float, str | None, float | None]:
    """
    Demote any non-neutral label below the confidence threshold to 'neutral'.

    Per §18 rule 4: after all prior steps, if final confidence < threshold,
    the label is demoted to 'neutral' and BOTH the original label AND the
    original score are returned for audit. Storing the original score means
    future threshold changes can be applied retroactively without
    re-classifying every post — the caller can simply compare the stored
    original_score against the new threshold.

    2026-07-29: threshold is now configurable via
    settings.sentiment_confidence_floor (default 0.55, was hardcoded 0.70).
    The old 0.70 value demoted 11,482 posts (25% of a 30-day corpus) that
    the model correctly identified as pos/neg. See docs/sentiment-audit
    for details.

    Parameters
    ----------
    label     : the label to evaluate ('positive' | 'negative' | 'neutral')
    score     : the confidence score [0, 1]
    threshold : override the settings-driven threshold (unit tests)

    Returns
    -------
    (final_label, final_score, original_label, original_score) where:
        final_label    — 'neutral' if demoted, else the original label
        final_score    — 0.5 if demoted, else the original score
        original_label — the pre-demotion label string if demoted, else None
        original_score — the pre-demotion score if demoted, else None
    """
    if threshold is None:
        from config import settings  # noqa: PLC0415
        threshold = settings.sentiment_confidence_floor
    if label != "neutral" and score < threshold:
        return ("neutral", 0.5, label, float(score))
    return (label, score, None, None)
