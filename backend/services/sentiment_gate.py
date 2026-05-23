"""
§18 Sentiment Trust Chain — signal-volume gate (Layer 1) and language gate (Layer 5).

This module is the entry point for the two gates implemented in PR #9.
Layers 2, 3, 4 (title/body separation, confidence floor, lexicon overlay)
are implemented in PR #10 and PR #11 respectively.

Public API
----------
count_substantive_tokens(text)         -> int
detect_language(text)                  -> str   (ISO 639-1 or 'und')
apply_signal_and_language_gate(...)    -> tuple[str, float, str]
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
    if token_count <= 2:
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
        return (raw_label, min(raw_score, 0.6), "medium")

    # signal_quality == "high"
    return (raw_label, raw_score, "high")
