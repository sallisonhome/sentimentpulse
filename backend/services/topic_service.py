"""
Topic extraction service.

Primary:  BERTopic (bertopic)
Fallback: Latent Dirichlet Allocation via scikit-learn

Extracted topic labels are upserted into the topic_trends table, updating
mention counts, last_seen date, trend direction, and velocity on each run.

After raw extraction, a Claude API call converts machine-readable keyword
clusters (e.g. "crash + fps + performance") into plain-English topic labels
(e.g. "Performance & FPS Problems") using the game name for context.
"""
import json
import logging
from datetime import date

from sqlalchemy.orm import Session

from models import TopicTrend, SentimentEnum, TrendDirectionEnum

logger = logging.getLogger(__name__)

_MIN_DOCS = 3       # Minimum texts required to attempt topic extraction
_N_TOPICS = 10      # Maximum topics to extract per sentiment group
_TOP_WORDS = 3      # Keywords to join for each topic label


# ── Public API ────────────────────────────────────────────────────────────────

def humanize_topic_labels(
    game_name: str,
    topics_by_sentiment: dict[str, list[str]],
) -> dict[str, list[str]]:
    """
    Convert raw keyword-cluster labels (e.g. "crash + fps + performance") into
    plain-English topic labels (e.g. "Performance & FPS Problems") using the
    Claude API for context-aware renaming.

    Accepts and returns the same topics_by_sentiment dict structure.
    Falls back to the original labels on any error so ingestion never breaks.
    """
    # Collect all unique raw labels across sentiments
    all_raw: list[str] = []
    for labels in topics_by_sentiment.values():
        for label in labels:
            if label not in all_raw:
                all_raw.append(label)

    if not all_raw:
        return topics_by_sentiment

    try:
        humanized_map = _call_claude_humanize(game_name, all_raw)
    except Exception as exc:
        logger.warning("Topic humanization failed for '%s': %s — using raw labels.", game_name, exc)
        return topics_by_sentiment

    # Apply the mapping, falling back to original label if Claude missed one
    result: dict[str, list[str]] = {}
    for sentiment, labels in topics_by_sentiment.items():
        result[sentiment] = [humanized_map.get(label, label) for label in labels]
    return result


def extract_topics(texts: list[str], n_topics: int = _N_TOPICS) -> list[str]:
    """
    Extract topic labels from a list of texts.

    Returns a list of human-readable topic label strings
    (e.g. "crash + performance + fps").

    Returns an empty list when fewer than _MIN_DOCS texts are provided or
    when both BERTopic and LDA fail.
    """
    # Filter out blank texts and very short ones (< 30 chars) — short Reddit
    # comments like "lmao sounds fun" produce meaningless topic clusters.
    clean = [t for t in texts if t and len(t.strip()) >= 30]
    if len(clean) < _MIN_DOCS:
        return []

    # Lightweight mode: skip BERTopic entirely, go straight to LDA
    from config import settings  # noqa: PLC0415
    if not settings.lightweight_nlp:
        try:
            return _bertopic(clean, n_topics)
        except Exception as exc:
            logger.warning("BERTopic failed (%s) — falling back to LDA.", exc)
    else:
        logger.info("Lightweight NLP mode — skipping BERTopic, using LDA only.")

    try:
        return _lda(clean, n_topics)
    except Exception as exc:
        logger.error("LDA also failed: %s", exc)
        return []


def upsert_topic_trends(
    db: Session,
    game_id: int,
    today: date,
    topics_by_sentiment: dict[str, list[str]],
) -> None:
    """
    Insert or update TopicTrend rows for a game based on today's extracted topics.

    topics_by_sentiment format:
        {"positive": ["topic a", "topic b"], "negative": [...], "neutral": [...]}

    Commits once after all upserts; rolls back and logs on DB error.
    """
    for sentiment_str, topic_labels in topics_by_sentiment.items():
        try:
            sentiment = SentimentEnum(sentiment_str)
        except ValueError:
            logger.warning(
                "Unknown sentiment value '%s' in topic upsert — skipping.",
                sentiment_str,
            )
            continue

        # Deduplicate: humanization can map multiple raw labels to the same
        # human label; only upsert each unique label once per sentiment.
        for label in dict.fromkeys(topic_labels):
            _upsert_one(db, game_id, label, sentiment, today)

    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error(
            "DB error committing topic trends for game_id=%d: %s", game_id, exc
        )


# ── Private: BERTopic ─────────────────────────────────────────────────────────

def _bertopic(texts: list[str], n_topics: int) -> list[str]:
    from bertopic import BERTopic  # noqa: PLC0415
    from sklearn.feature_extraction.text import CountVectorizer  # noqa: PLC0415

    # Use a stopword-aware vectorizer so common words like "the", "and", "of"
    # don't surface as topic keywords.
    vectorizer_model = CountVectorizer(stop_words="english", min_df=1)

    model = BERTopic(
        nr_topics=n_topics,
        min_topic_size=_MIN_DOCS,
        verbose=False,
        calculate_probabilities=False,
        vectorizer_model=vectorizer_model,
    )
    model.fit_transform(texts)

    labels = []
    for _, row in model.get_topic_info().iterrows():
        topic_id = row["Topic"]
        if topic_id == -1:      # BERTopic outlier cluster — skip
            continue
        words = model.get_topic(topic_id)
        if words:
            label = " + ".join(w for w, _ in words[:_TOP_WORDS])
            labels.append(label)

    return labels


# ── Private: LDA fallback ─────────────────────────────────────────────────────

def _lda(texts: list[str], n_topics: int) -> list[str]:
    from sklearn.feature_extraction.text import TfidfVectorizer  # noqa: PLC0415
    from sklearn.decomposition import LatentDirichletAllocation   # noqa: PLC0415

    vectorizer = TfidfVectorizer(
        max_df=0.95,
        min_df=2,
        max_features=1000,
        stop_words="english",
    )
    dtm = vectorizer.fit_transform(texts)

    # Clamp n_topics to what the corpus actually supports
    actual_n = min(n_topics, dtm.shape[0] - 1, dtm.shape[1] - 1)
    if actual_n < 1:
        return []

    lda = LatentDirichletAllocation(
        n_components=actual_n,
        random_state=42,
        max_iter=10,
    )
    lda.fit(dtm)

    feature_names = vectorizer.get_feature_names_out()
    labels = []
    for topic_vec in lda.components_:
        top_indices = topic_vec.argsort()[::-1][:_TOP_WORDS]
        label = " + ".join(feature_names[i] for i in top_indices)
        labels.append(label)

    return labels


# ── Private: Claude label humanization ───────────────────────────────────────

_HUMANIZE_BATCH_SIZE = 15   # Max labels per Claude call to avoid truncated JSON


def _call_claude_humanize(game_name: str, raw_labels: list[str]) -> dict[str, str]:
    """
    Send raw topic keyword clusters to Claude and get back plain-English labels.

    Processes labels in batches of _HUMANIZE_BATCH_SIZE to prevent Claude from
    returning truncated or malformed JSON on large label sets.

    Returns a dict mapping raw_label → human_label.
    Raises on any API or parse error so the caller can fall back gracefully.
    """
    from services.summary_service import _resolve_api_key  # noqa: PLC0415

    api_key = _resolve_api_key()
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not configured")

    import anthropic  # noqa: PLC0415

    client = anthropic.Anthropic(api_key=api_key, base_url="https://api.anthropic.com")

    merged: dict[str, str] = {}
    for i in range(0, len(raw_labels), _HUMANIZE_BATCH_SIZE):
        batch = raw_labels[i : i + _HUMANIZE_BATCH_SIZE]
        batch_map = _call_claude_humanize_batch(client, game_name, batch)
        merged.update(batch_map)

    return merged


def _call_claude_humanize_batch(client, game_name: str, raw_labels: list[str]) -> dict[str, str]:
    """Send a single batch of labels to Claude and parse the JSON response."""
    clusters_text = "\n".join(f"- {label}" for label in raw_labels)
    prompt = (
        f'You are labelling discussion topics for a game community sentiment dashboard.\n'
        f'Game: "{game_name}"\n\n'
        f'Below are raw keyword clusters extracted automatically from player reviews '
        f'and forum posts. For each cluster, write a 2-5 word plain-English topic label '
        f'that a non-technical person would immediately understand. '
        f'Labels should be specific to gaming context and reflect what players are actually discussing.\n\n'
        f'Good examples:\n'
        f'- "crash + fps + performance" → "Performance & FPS Issues"\n'
        f'- "love + game + play" → "Enjoyable Gameplay"\n'
        f'- "multiplayer + online + bug" → "Multiplayer Connectivity Bugs"\n'
        f'- "story + narrative + ending" → "Story & Narrative"\n'
        f'- "price + worth + value" → "Price vs Value"\n\n'
        f'Raw clusters to label:\n{clusters_text}\n\n'
        f'Respond with ONLY a valid JSON object mapping each raw label to its human-readable label. '
        f'Include every label from the list above. No extra text, no markdown fences.\n'
        f'Example format: {{"crash + fps + performance": "Performance & FPS Issues"}}'
    )

    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )
    response_text = message.content[0].text.strip()

    # Strip markdown code fences if present
    if response_text.startswith("```"):
        lines = response_text.split("\n")
        response_text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    mapping: dict[str, str] = json.loads(response_text)
    return mapping


# ── Private: DB upsert ────────────────────────────────────────────────────────

def _upsert_one(
    db: Session,
    game_id: int,
    topic_label: str,
    sentiment: SentimentEnum,
    today: date,
) -> None:
    """Insert a new TopicTrend row or increment an existing one."""
    existing: TopicTrend | None = (
        db.query(TopicTrend)
        .filter_by(game_id=game_id, topic_label=topic_label, sentiment=sentiment)
        .first()
    )

    if existing is None:
        db.add(TopicTrend(
            game_id=game_id,
            topic_label=topic_label,
            sentiment=sentiment,
            first_seen=today,
            last_seen=today,
            mention_count=1,
            trend_direction=TrendDirectionEnum.stable,
            velocity=0.0,
        ))
        return

    # ── Update existing row ───────────────────────────────────────────────────
    prev_count = existing.mention_count
    existing.mention_count += 1
    existing.last_seen = today

    days_active = max(1, (today - existing.first_seen).days)
    new_velocity = existing.mention_count / days_active
    prev_velocity = prev_count / days_active if days_active > 0 else 0.0

    existing.velocity = new_velocity

    if new_velocity > prev_velocity * 1.2:
        existing.trend_direction = TrendDirectionEnum.rising
    elif new_velocity < prev_velocity * 0.8:
        existing.trend_direction = TrendDirectionEnum.falling
    else:
        existing.trend_direction = TrendDirectionEnum.stable
