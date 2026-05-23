"""
NLP sentiment classification service.

Primary:  cardiffnlp/twitter-roberta-base-sentiment-latest (HuggingFace Transformers)
Fallback: VADER (vaderSentiment) — used when the transformer model cannot be
          loaded (e.g. no internet at startup, insufficient memory, no GPU).

Call load_model() once at application startup.  All subsequent calls to
classify_sentiment() / classify_batch() are thread-safe reads of module-level
state.
"""
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# ── Module-level model state (populated by load_model()) ──────────────────────
_pipeline = None        # transformers.Pipeline object
_use_vader: bool = False
_vader_analyzer = None

_MODEL_NAME = "cardiffnlp/twitter-roberta-base-sentiment-latest"
_MAX_INPUT_CHARS = 2000   # Truncate before tokenisation to avoid OOM
_BATCH_SIZE = 16

# cardiffnlp model uses these label strings directly; some older checkpoints
# fall back to LABEL_0/1/2 — map both to our canonical three-value enum.
_LABEL_MAP: dict[str, str] = {
    "positive": "positive",
    "negative": "negative",
    "neutral": "neutral",
    "LABEL_0": "negative",
    "LABEL_1": "neutral",
    "LABEL_2": "positive",
}


# ── Initialisation ────────────────────────────────────────────────────────────

def load_model() -> None:
    """
    Load the transformer sentiment pipeline.
    On any failure, falls back to VADER and logs a warning.
    Safe to call multiple times (no-op if already loaded).
    """
    global _pipeline, _use_vader, _vader_analyzer

    if _pipeline is not None or _use_vader:
        return  # already initialised

    # Lightweight mode: skip the heavy transformer model entirely
    from config import settings  # noqa: PLC0415
    if settings.lightweight_nlp:
        logger.info("Lightweight NLP mode — skipping transformer, using VADER only.")
        _use_vader = True
        _load_vader()
        return

    try:
        from transformers import pipeline as hf_pipeline  # noqa: PLC0415

        logger.info("Loading NLP model: %s", _MODEL_NAME)
        _pipeline = hf_pipeline(
            "sentiment-analysis",
            model=_MODEL_NAME,
            truncation=True,
            max_length=514,   # RoBERTa limit (512 + 2 special tokens)
            top_k=None,       # Return scores for all labels, not just the best
        )
        logger.info("Transformer model loaded successfully.")

    except Exception as exc:
        logger.warning(
            "Could not load transformer model (%s). Falling back to VADER.", exc
        )
        _use_vader = True
        _load_vader()


def _load_vader() -> None:
    global _vader_analyzer
    try:
        from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer  # noqa
        _vader_analyzer = SentimentIntensityAnalyzer()
        logger.info("VADER analyzer loaded.")
    except Exception as exc:
        logger.error("Could not load VADER analyzer: %s", exc)


# ── Public API ────────────────────────────────────────────────────────────────

def classify_sentiment(text: str) -> tuple[str, float]:
    """
    Classify a single text string.

    Returns (label, score) where:
        label  — 'positive' | 'negative' | 'neutral'
        score  — confidence float in [0, 1]

    Returns ('neutral', 0.5) for empty input.
    """
    if not text or not text.strip():
        return "neutral", 0.5

    if _use_vader or _pipeline is None:
        return _classify_vader(text)

    return _classify_roberta_single(text)


def classify_batch(texts: list[str]) -> list[tuple[str, float]]:
    """
    Classify a list of texts efficiently.

    Returns a list of (label, score) tuples in the same order as `texts`.
    Falls back to VADER per-item if the batch transformer call fails.
    """
    if not texts:
        return []

    if _use_vader or _pipeline is None:
        return [_classify_vader(t) for t in texts]

    try:
        truncated = [_truncate(t) for t in texts]
        raw_results = _pipeline(truncated, batch_size=_BATCH_SIZE)
        output = []
        for result in raw_results:
            # result is a list of {"label": str, "score": float} (top_k=None)
            best = max(result, key=lambda x: x["score"])
            label = _LABEL_MAP.get(best["label"], "neutral")
            output.append((label, float(best["score"])))
        return output

    except Exception as exc:
        logger.error(
            "Batch transformer classification failed (%s) — using VADER per item.",
            exc,
        )
        return [_classify_vader(t) for t in texts]


# ── §18 Gate-aware entry points ─────────────────────────────────────────────

def classify_with_gate(text: str) -> dict:
    """
    Classify a single text string and apply the §18 signal-volume + language gates.

    Returns a dict with keys:
        label          — final sentiment label after gates ('positive'|'negative'|'neutral')
        score          — final confidence score [0, 1] after gates
        signal_quality — 'low' | 'medium' | 'high'
        language       — ISO 639-1 code or 'und'

    Backward-compatible: classify_sentiment() / classify_batch() are unchanged.
    """
    from services.sentiment_gate import (
        apply_signal_and_language_gate,
        detect_language,
    )

    raw_label, raw_score = classify_sentiment(text)
    language = detect_language(text)
    final_label, final_score, signal_quality = apply_signal_and_language_gate(
        text, raw_label, raw_score, language
    )
    return {
        "label": final_label,
        "score": final_score,
        "signal_quality": signal_quality,
        "language": language,
    }


def classify_batch_with_gate(texts: list[str]) -> list[dict]:
    """
    Classify a list of texts and apply the §18 gates to each.

    Returns a list of dicts (same structure as classify_with_gate()),
    in the same order as `texts`.
    """
    from services.sentiment_gate import (
        apply_signal_and_language_gate,
        detect_language,
    )

    raw_results = classify_batch(texts)
    output = []
    for text, (raw_label, raw_score) in zip(texts, raw_results):
        language = detect_language(text)
        final_label, final_score, signal_quality = apply_signal_and_language_gate(
            text, raw_label, raw_score, language
        )
        output.append({
            "label": final_label,
            "score": final_score,
            "signal_quality": signal_quality,
            "language": language,
        })
    return output


# ── Private helpers ───────────────────────────────────────────────────────────

def _classify_roberta_single(text: str) -> tuple[str, float]:
    """Classify one text with the transformer pipeline."""
    try:
        result = _pipeline(_truncate(text), top_k=None)
        best = max(result[0], key=lambda x: x["score"])
        label = _LABEL_MAP.get(best["label"], "neutral")
        return label, float(best["score"])
    except Exception as exc:
        logger.warning(
            "RoBERTa single-item classification error (%s) — using VADER.", exc
        )
        return _classify_vader(text)


def _classify_vader(text: str) -> tuple[str, float]:
    """
    Classify one text using VADER.

    VADER compound score range [-1, 1] is mapped to a [0, 1] confidence:
        positive (compound >= 0.05):  score = (compound + 1) / 2
        negative (compound <= -0.05): score = (1 - compound) / 2
        neutral:                       score = 0.5
    """
    if _vader_analyzer is None:
        _load_vader()
    if _vader_analyzer is None:
        return "neutral", 0.5

    try:
        scores = _vader_analyzer.polarity_scores(text)
        compound = scores["compound"]
        if compound >= 0.05:
            return "positive", float(min(1.0, (compound + 1) / 2))
        if compound <= -0.05:
            return "negative", float(min(1.0, (1 - compound) / 2))
        return "neutral", 0.5
    except Exception as exc:
        logger.error("VADER classification error: %s", exc)
        return "neutral", 0.5


def _truncate(text: str) -> str:
    """Truncate text to avoid tokeniser OOM on very long inputs."""
    return text[:_MAX_INPUT_CHARS] if text else ""
