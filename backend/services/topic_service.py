"""
Topic extraction service.

Primary:  BERTopic (bertopic)
Fallback: Latent Dirichlet Allocation via scikit-learn

Extracted topic labels are upserted into the topic_trends table, updating
mention counts, last_seen date, trend direction, and velocity on each run.
"""
import logging
from datetime import date

from sqlalchemy.orm import Session

from models import TopicTrend, SentimentEnum, TrendDirectionEnum

logger = logging.getLogger(__name__)

_MIN_DOCS = 3       # Minimum texts required to attempt topic extraction
_N_TOPICS = 10      # Maximum topics to extract per sentiment group
_TOP_WORDS = 3      # Keywords to join for each topic label


# ── Public API ────────────────────────────────────────────────────────────────

def extract_topics(texts: list[str], n_topics: int = _N_TOPICS) -> list[str]:
    """
    Extract topic labels from a list of texts.

    Returns a list of human-readable topic label strings
    (e.g. "crash + performance + fps").

    Returns an empty list when fewer than _MIN_DOCS texts are provided or
    when both BERTopic and LDA fail.
    """
    clean = [t for t in texts if t and t.strip()]
    if len(clean) < _MIN_DOCS:
        return []

    try:
        return _bertopic(clean, n_topics)
    except Exception as exc:
        logger.warning("BERTopic failed (%s) — falling back to LDA.", exc)

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

        for label in topic_labels:
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

    model = BERTopic(
        nr_topics=n_topics,
        min_topic_size=_MIN_DOCS,
        verbose=False,
        calculate_probabilities=False,
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
