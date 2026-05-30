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


def extract_topics_with_metadata(
    texts: list[str],
    author_ids: list[str],
    day_ids: list[str],
    n_topics: int = _N_TOPICS,
) -> list[dict]:
    """
    Extract topics from texts and return per-cluster metadata for the §15
    critical-mass gate.

    Parameters
    ----------
    texts      : list of post text strings (same order as author_ids / day_ids)
    author_ids : list of author identifiers parallel to texts
    day_ids    : list of date strings (e.g. "2024-04-15") parallel to texts
    n_topics   : max topics to extract (forwarded to extract_topics)

    Returns
    -------
    list of dicts, each with keys:
        label      : str  — raw topic label (before humanization)
        post_count : int  — number of texts assigned to this cluster
        author_ids : set  — distinct author identifiers
        day_set    : set  — distinct day strings

    Returns an empty list when fewer than _MIN_DOCS texts are provided or
    both BERTopic and LDA fail.
    """
    clean_indices, clean_texts = _filter_texts(texts)
    if len(clean_texts) < _MIN_DOCS:
        return []

    # We attempt clustering — get per-document cluster assignments so we can
    # compute author/day metadata per cluster.
    try:
        cluster_labels_raw = _cluster_with_assignments(clean_texts, n_topics)
    except Exception as exc:
        logger.error("extract_topics_with_metadata clustering failed: %s", exc)
        return []

    # Build metadata per cluster
    cluster_meta: dict[str, dict] = {}
    for local_idx, cluster_id in enumerate(cluster_labels_raw):
        if cluster_id is None:
            continue  # outlier from BERTopic
        original_idx = clean_indices[local_idx]
        author = author_ids[original_idx] if original_idx < len(author_ids) else "unknown"
        day = day_ids[original_idx] if original_idx < len(day_ids) else "unknown"

        if cluster_id not in cluster_meta:
            cluster_meta[cluster_id] = {
                "label": cluster_id,
                "post_count": 0,
                "author_ids": set(),
                "day_set": set(),
            }
        cluster_meta[cluster_id]["post_count"] += 1
        cluster_meta[cluster_id]["author_ids"].add(author)
        cluster_meta[cluster_id]["day_set"].add(day)

    return list(cluster_meta.values())


def _filter_texts(texts: list[str]) -> tuple[list[int], list[str]]:
    """Return (original_indices, clean_texts) filtered to len >= 30 chars."""
    indices = []
    clean = []
    for i, t in enumerate(texts):
        if t and len(t.strip()) >= 30:
            indices.append(i)
            clean.append(t)
    return indices, clean


def _cluster_with_assignments(texts: list[str], n_topics: int) -> list[object]:
    """
    Run topic clustering and return a list of cluster-id assignments,
    one per input text.  Cluster IDs are strings (the raw label).
    Outliers are represented as None.

    Falls back: BERTopic → LDA.
    """
    from config import settings  # noqa: PLC0415
    if not settings.lightweight_nlp:
        try:
            return _bertopic_assignments(texts, n_topics)
        except Exception as exc:
            logger.warning("BERTopic assignments failed (%s) — falling back to LDA.", exc)
    else:
        logger.info("Lightweight NLP mode — skipping BERTopic, using LDA only.")

    try:
        return _lda_assignments(texts, n_topics)
    except Exception as exc:
        logger.error("LDA assignments also failed: %s", exc)
        return [None] * len(texts)


def _bertopic_assignments(texts: list[str], n_topics: int) -> list[object]:
    """Run BERTopic and return per-text cluster label strings (None for outliers)."""
    from bertopic import BERTopic  # noqa: PLC0415
    from sklearn.feature_extraction.text import CountVectorizer  # noqa: PLC0415

    vectorizer_model = CountVectorizer(stop_words="english", min_df=1)
    model = BERTopic(
        nr_topics=n_topics,
        min_topic_size=_MIN_DOCS,
        verbose=False,
        calculate_probabilities=False,
        vectorizer_model=vectorizer_model,
    )
    topic_ids, _ = model.fit_transform(texts)

    # Build label map: topic_id (int) → label string
    label_map: dict[int, str] = {}
    for _, row in model.get_topic_info().iterrows():
        tid = row["Topic"]
        if tid == -1:
            continue
        words = model.get_topic(tid)
        if words:
            label_map[tid] = " + ".join(w for w, _ in words[:_TOP_WORDS])

    return [
        label_map.get(tid, None)  # None for outlier (-1)
        for tid in topic_ids
    ]


def _lda_assignments(texts: list[str], n_topics: int) -> list[object]:
    """Run LDA and return per-text cluster label strings (never None — every
    doc has a dominant topic)."""
    from sklearn.feature_extraction.text import TfidfVectorizer  # noqa: PLC0415
    from sklearn.decomposition import LatentDirichletAllocation   # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    vectorizer = TfidfVectorizer(
        max_df=0.95,
        min_df=2,
        max_features=1000,
        stop_words="english",
    )
    dtm = vectorizer.fit_transform(texts)

    actual_n = min(n_topics, dtm.shape[0] - 1, dtm.shape[1] - 1)
    if actual_n < 1:
        return ["topic_0"] * len(texts)

    lda = LatentDirichletAllocation(
        n_components=actual_n,
        random_state=42,
        max_iter=10,
    )
    doc_topics = lda.fit_transform(dtm)

    feature_names = vectorizer.get_feature_names_out()
    # Build label for each LDA component
    labels: list[str] = []
    for topic_vec in lda.components_:
        top_indices = topic_vec.argsort()[::-1][:_TOP_WORDS]
        label = " + ".join(feature_names[i] for i in top_indices)
        labels.append(label)

    # Assign each document to its dominant topic
    import numpy as np  # noqa: PLC0415,F811
    return [
        labels[int(np.argmax(doc_topic_vec))]
        for doc_topic_vec in doc_topics
    ]


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

# Concepts Claude is forbidden from inventing (CLAUDE.md §13). If the humanized
# label contains any of these tokens but the raw cluster does NOT, the label is
# rejected and we fall back to the raw cluster. Tokens are checked as substrings
# against a lowercased, punctuation-normalized form of both strings.
_FORBIDDEN_CONCEPT_TOKENS = (
    "free to play", "free-to-play", "f2p",
    "battle pass", "battlepass",
    "monetization", "monetisation",
    "microtransaction", "micro-transaction",
    "gacha",
    "live service",
    "season pass", "seasonpass",
    "pay to win", "pay-to-win", "p2w",
    "loot box", "lootbox",
    "subscription",
    "dlc",
)


def _normalize_for_check(s: str) -> str:
    """Lowercase + collapse non-alphanumerics to single spaces for substring match."""
    import re  # noqa: PLC0415
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def _label_violates_evidence_rule(humanized: str, raw_cluster: str) -> bool:
    """Return True if the humanized label introduces a forbidden concept that
    the raw cluster does NOT contain.

    This is the belt to the prompt's suspenders. Even with explicit negative
    examples in the prompt, the LLM occasionally introduces F2P / battle-pass /
    monetization framing for clusters that have none of those words.
    """
    h = _normalize_for_check(humanized)
    r = _normalize_for_check(raw_cluster)
    for tok in _FORBIDDEN_CONCEPT_TOKENS:
        if tok in h and tok not in r:
            return True
    return False


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
        # Post-LLM filter: reject any humanized label that introduces a forbidden
        # concept not present in the source cluster. Fall back to the raw label.
        for raw_label, human_label in batch_map.items():
            if not isinstance(human_label, str) or not human_label.strip():
                merged[raw_label] = raw_label
                continue
            if _label_violates_evidence_rule(human_label, raw_label):
                logger.warning(
                    "Topic label rejected for hallucinated concept — raw=%r humanized=%r (using raw label)",
                    raw_label, human_label,
                )
                merged[raw_label] = raw_label
            else:
                merged[raw_label] = human_label.strip()

    return merged


def _call_claude_humanize_batch(client, game_name: str, raw_labels: list[str]) -> dict[str, str]:
    """Send a single batch of labels to Claude and parse the JSON response.

    CRITICAL: the label MUST be derived only from the words present in the raw
    cluster. Claude is explicitly forbidden from introducing gaming-industry
    concepts (F2P, battle pass, monetization model, etc.) that don't appear in
    the cluster. When a cluster is ambiguous or generic, the human label must
    reflect that — do not invent specificity.

    See CLAUDE.md §13 for the project-wide evidence-only rule this enforces.
    """
    clusters_text = "\n".join(f"- {label}" for label in raw_labels)
    prompt = (
        f'You are labelling discussion topics for a game community sentiment dashboard.\n'
        f'Game: "{game_name}"\n\n'
        f'HARD RULES — NO INVENTING, NO SPECULATING, PREFER SPECIFICITY:\n'
        f'1. The label MUST be derived ONLY from the words in the raw cluster. Do not '
        f'add concepts the cluster does not contain.\n'
        f'2. NEVER introduce these gaming-industry concepts unless the EXACT word is in the cluster: '
        f'"free-to-play", "f2p", "battle pass", "monetization", "microtransactions", "gacha", '
        f'"live service", "season pass", "pay-to-win", "loot box", "subscription". '
        f'("DLC" and "chapter pack" are OK to use if their exact words appear in the cluster.) '
        f'These are dashboard-poisoning false positives — a generic cluster like "free + play + game" '
        f'does NOT imply free-to-play; it is players using common verbs.\n'
        f'3. PREFER SPECIFICITY: if the cluster contains a proper noun, named entity, character, '
        f'level, weapon, mode, version number, or content drop (e.g. "tyranid + warrior + boss", '
        f'"salamanders + chapter + pack", "patch + 1.7 + balance"), build the label around THAT '
        f'specific element. Specifics > generic buckets every time. Do NOT collapse a specific '
        f'cluster into "General Discussion".\n'
        f'4. Use "General Discussion" / "General Positive Sentiment" / "General Gameplay Talk" '
        f'ONLY when the cluster is genuinely composed of stopword-adjacent verbs and adjectives '
        f'(e.g. "think + want + would", "good + great + fun"). When proper nouns or named '
        f'features ARE present, do NOT default to a generic label.\n'
        f'5. The label must read as a topic of discussion, not a marketing claim or feature ad.\n'
        f'6. 2-6 words. Use "&" for compound topics. No emojis, no quotation marks in the label.\n\n'
        f'GOOD examples — specifics preserved:\n'
        f'- "crash + fps + performance" → "Performance & FPS Issues"\n'
        f'- "tyranid + warrior + boss" → "Tyranid Warrior Boss Fight"\n'
        f'- "salamanders + chapter + pack" → "Salamanders Chapter Pack"\n'
        f'- "patch + 1.7 + balance" → "Patch 1.7 Balance"\n'
        f'- "pistol + damage + nerf" → "Pistol Damage Nerf"\n'
        f'- "helldive + difficulty + ammo" → "Helldive Difficulty Ammo"\n'
        f'- "multiplayer + online + bug" → "Multiplayer Connectivity Bugs"\n'
        f'- "story + narrative + ending" → "Story & Narrative"\n'
        f'- "price + worth + value" → "Price vs Value"\n'
        f'- "trailer + announce + reveal" → "Trailers & Announcements"\n\n'
        f'GOOD examples — honest generic when cluster IS generic:\n'
        f'- "good + great + fun" → "General Positive Sentiment"\n'
        f'- "think + want + would" → "General Discussion"\n'
        f'- "love + game + play" → "General Positive Sentiment"   (NOT "Free to Play Model" — "free" is not in this cluster, and "play" is a verb here)\n\n'
        f'BAD examples (hallucinations to NEVER produce):\n'
        f'- "free + play + game" → "Free to Play Model"        BAD: "free" is a verb modifier here, not a business model\n'
        f'- "john + wick + game" → "Free-to-Play John Wick"   BAD: cluster contains nothing about pricing\n'
        f'- "like + good + game" → "Battle Pass Success"      BAD: cluster has no battle-pass words\n'
        f'- "competitor + alternative + similar" → "F2P Competitive Positioning"   BAD: F2P is not in the cluster\n'
        f'- "tyranid + warrior + boss" → "Combat Mechanics"   BAD: dropped the specific entity (rule 3 violation)\n'
        f'- "salamanders + chapter + pack" → "General Positive Sentiment"   BAD: cluster names a specific content drop\n\n'
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
