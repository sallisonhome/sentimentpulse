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


# ── §18 PR #11: Full trust-chain gate (Layers 1-5 inc. Layer 4 lexicon) ────────

def classify_with_gate_v2(title: str, body: str) -> dict:
    """
    Full §18 trust-chain gate for a single post (Layers 1, 2, 3, 4, 5).

    Changed signature vs the PR #9 `classify_with_gate(text)`: accepts
    separate title and body strings so Layer 2 (title/body separation) can
    operate on them independently before combining.

    Pipeline
    --------
    a. Detect language on combined title+body.  Non-English → return neutral
       immediately, with signal_quality from the combined token count.
    b. Compute signal_quality from combined token count.
    c. signal=low → return neutral 0.5.
    d. Classify title-only AND body-only independently (raw model outputs).
    e. Apply signal cap (0.6) to each score if signal=medium.
    f. If body is empty/very short (<30 chars): use title result as combined.
       Else: call combine_title_body() → (label, score, conflict).
    g. apply_confidence_floor(): if final_score < 0.70 → demote to neutral,
       record original_label.
    h. (Layer 4) apply_lexicon_rules(): gaming-domain override rules.
       Only fires when language=en AND signal_quality != low.
    i. Return dict with all §18 audit fields.

    Returns
    -------
    {
        label          : 'positive' | 'negative' | 'neutral',
        score          : float,
        signal_quality : 'low' | 'medium' | 'high',
        language       : ISO 639-1 or 'und',
        original_label : str | None   (pre-floor label when demoted),
        sentiment_conflict : bool,
        applied_rules  : list[str]    (rule IDs that fired; [] when none),
    }
    """
    from services.sentiment_gate import (
        apply_signal_and_language_gate,
        apply_confidence_floor,
        combine_title_body,
        count_substantive_tokens,
        detect_language,
    )

    title = title or ""
    body = body or ""
    combined = (title + " " + body).strip()

    # ── Empty input guard ────────────────────────────────────────────────────
    if not combined:
        return {
            "label": "neutral",
            "score": 0.5,
            "signal_quality": "low",
            "language": "und",
            "original_label": None,
            "sentiment_conflict": False,
            "applied_rules": [],
        }

    # ── (a) Language detection on combined text ───────────────────────────────
    language = detect_language(combined)

    # ── (b) Signal quality from combined token count ──────────────────────────
    token_count = count_substantive_tokens(combined)
    if token_count <= 2:
        signal_quality = "low"
    elif token_count <= 6:
        signal_quality = "medium"
    else:
        signal_quality = "high"

    # ── (a) Non-English → immediate neutral ───────────────────────────────────
    if language != "en":
        return {
            "label": "neutral",
            "score": 0.5,
            "signal_quality": signal_quality,
            "language": language,
            "original_label": None,
            "sentiment_conflict": False,
            "applied_rules": [],
        }

    # ── (c) Low signal → immediate neutral ───────────────────────────────────
    if signal_quality == "low":
        return {
            "label": "neutral",
            "score": 0.5,
            "signal_quality": "low",
            "language": language,
            "original_label": None,
            "sentiment_conflict": False,
            "applied_rules": [],
        }

    # ── (d) Classify title and body independently ─────────────────────────────
    # Classify title; if title is empty, use combined as the title text
    title_text = title.strip() if title.strip() else combined
    body_text = body.strip()

    if body_text and len(body_text) >= 30:
        # Both title and body are substantial — classify each independently
        raw_title_label, raw_title_score = classify_sentiment(title_text)
        raw_body_label, raw_body_score = classify_sentiment(body_text)
    else:
        # Body absent/short — only title matters
        raw_title_label, raw_title_score = classify_sentiment(title_text)
        raw_body_label, raw_body_score = raw_title_label, raw_title_score

    # ── (e) Apply medium signal cap ───────────────────────────────────────────
    if signal_quality == "medium":
        raw_title_score = min(raw_title_score, 0.6)
        raw_body_score = min(raw_body_score, 0.6)

    # ── (f) Combine title + body ──────────────────────────────────────────────
    if not body_text or len(body_text) < 30:
        # Short/empty body → use title result directly
        final_label = raw_title_label
        final_score = raw_title_score
        sentiment_conflict = False
    else:
        final_label, final_score, sentiment_conflict = combine_title_body(
            raw_title_label, raw_title_score,
            raw_body_label, raw_body_score,
            title, body,
        )

    # ── (g) Apply confidence floor ────────────────────────────────────────────
    final_label, final_score, original_label = apply_confidence_floor(
        final_label, final_score
    )

    pre_lexicon = {
        "label": final_label,
        "score": final_score,
        "signal_quality": signal_quality,
        "language": language,
        "original_label": original_label,
        "sentiment_conflict": sentiment_conflict,
    }

    # ── (h) Layer 4: gaming-domain lexicon overlay ───────────────────────────
    from services.sentiment_lexicon import _get_rules, apply_lexicon_rules  # noqa: PLC0415
    rules = _get_rules()
    return apply_lexicon_rules(title, body, pre_lexicon, rules)


def classify_batch_with_gate_v2(items: list[dict]) -> list[dict]:
    """
    Classify a batch of {title, body} dicts through the full §18 trust chain.

    Uses batched model calls for efficiency: flattens [title1, body1, title2,
    body2, ...] into a single classify_batch() call, then unflattens results.

    Parameters
    ----------
    items : list of dicts with keys 'title' and 'body' (both may be empty/None)

    Returns
    -------
    list of §18 result dicts (same structure as classify_with_gate_v2()),
    in the same order as `items`.
    """
    from services.sentiment_gate import (
        apply_confidence_floor,
        combine_title_body,
        count_substantive_tokens,
        detect_language,
    )

    if not items:
        return []

    # ── Pre-compute per-item metadata (language, signal_quality) ─────────────
    combined_texts: list[str] = []
    languages: list[str] = []
    signal_qualities: list[str] = []

    for item in items:
        title = (item.get("title") or "").strip()
        body = (item.get("body") or "").strip()
        combined = (title + " " + body).strip()
        combined_texts.append(combined)

        lang = detect_language(combined) if combined else "und"
        languages.append(lang)

        token_count = count_substantive_tokens(combined)
        if token_count <= 2:
            signal_qualities.append("low")
        elif token_count <= 6:
            signal_qualities.append("medium")
        else:
            signal_qualities.append("high")

    # ── Build the flat list of texts to classify ──────────────────────────────
    # For items that need classification (non-empty, English, non-low signal),
    # we classify both title and body independently.  Items that short-circuit
    # get placeholder texts so indices stay aligned.
    flat_texts: list[str] = []
    needs_model: list[bool] = []

    for i, item in enumerate(items):
        title = (item.get("title") or "").strip()
        body = (item.get("body") or "").strip()
        combined = combined_texts[i]
        lang = languages[i]
        sq = signal_qualities[i]

        if not combined or lang != "en" or sq == "low":
            # Will short-circuit — push placeholders to keep indices aligned
            flat_texts.append("")   # title slot
            flat_texts.append("")   # body slot
            needs_model.append(False)
        else:
            title_text = title if title else combined
            body_text = body
            flat_texts.append(title_text)
            flat_texts.append(body_text if body_text and len(body_text) >= 30 else "")
            needs_model.append(True)

    # ── Single batched model call ─────────────────────────────────────────────
    # classify_batch handles empty strings as ("neutral", 0.5) — safe.
    flat_results = classify_batch(flat_texts)

    # ── Reconstruct per-item results ──────────────────────────────────────────
    output: list[dict] = []
    for i, item in enumerate(items):
        title = (item.get("title") or "").strip()
        body = (item.get("body") or "").strip()
        lang = languages[i]
        sq = signal_qualities[i]
        combined = combined_texts[i]

        # Short-circuit cases
        if not combined:
            output.append({
                "label": "neutral",
                "score": 0.5,
                "signal_quality": "low",
                "language": "und",
                "original_label": None,
                "sentiment_conflict": False,
                "applied_rules": [],
            })
            continue

        if lang != "en":
            output.append({
                "label": "neutral",
                "score": 0.5,
                "signal_quality": sq,
                "language": lang,
                "original_label": None,
                "sentiment_conflict": False,
                "applied_rules": [],
            })
            continue

        if sq == "low":
            output.append({
                "label": "neutral",
                "score": 0.5,
                "signal_quality": "low",
                "language": lang,
                "original_label": None,
                "sentiment_conflict": False,
                "applied_rules": [],
            })
            continue

        # Pull raw scores from flat_results
        title_slot = i * 2
        body_slot = i * 2 + 1
        raw_title_label, raw_title_score = flat_results[title_slot]
        raw_body_label, raw_body_score = flat_results[body_slot]

        # Apply medium signal cap
        if sq == "medium":
            raw_title_score = min(raw_title_score, 0.6)
            raw_body_score = min(raw_body_score, 0.6)

        # Combine — body slot is "" if body short/absent
        body_text_raw = (item.get("body") or "").strip()
        if not body_text_raw or len(body_text_raw) < 30:
            # Body absent — use title result; body slot was placeholder
            final_label = raw_title_label
            final_score = raw_title_score
            sentiment_conflict = False
        else:
            final_label, final_score, sentiment_conflict = combine_title_body(
                raw_title_label, raw_title_score,
                raw_body_label, raw_body_score,
                title, body_text_raw,
            )

        # Confidence floor
        final_label, final_score, original_label = apply_confidence_floor(
            final_label, final_score
        )

        pre_lexicon = {
            "label": final_label,
            "score": final_score,
            "signal_quality": sq,
            "language": lang,
            "original_label": original_label,
            "sentiment_conflict": sentiment_conflict,
        }

        # Layer 4: gaming-domain lexicon overlay
        from services.sentiment_lexicon import _get_rules, apply_lexicon_rules  # noqa: PLC0415
        lexicon_rules = _get_rules()
        item_title = (item.get("title") or "").strip()
        item_body = (item.get("body") or "").strip()
        output.append(apply_lexicon_rules(item_title, item_body, pre_lexicon, lexicon_rules))

    return output
