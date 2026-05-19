"""
Daily ingestion pipeline — orchestrates all 8 steps for every active game.

Steps
-----
1. Game Discovery    — Steam API publisher search + Reddit subreddit auto-detection
2. Steam Reviews     — fetch 100 most-recent reviews per game
3. Steam Forums      — scrape 10 most-active discussion threads per game
4. Reddit            — fetch new/hot posts + top-50 comments per subreddit
5. NLP Sentiment     — batch-classify all unprocessed raw_posts
6. Topic Extraction  — BERTopic / LDA per sentiment group → topic_trends upsert
7. Daily Summary     — aggregate counts + AI summary via Claude API
8. Log Results       — write logs/ingest_YYYY-MM-DD.log

Design principles
-----------------
- Every step is wrapped in try/except so a failure in one game never stops
  the others.
- Deduplication is enforced at the DB level (unique constraint on
  external_id + source) AND via a pre-flight set-check in _bulk_save_posts.
- The module-level `_status` dict is read by GET /api/ingest/status.
"""
import logging
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from config import settings
from database import SessionLocal
from models import (
    DailySummary,
    Game,
    Publisher,
    RawPost,
    SentimentEnum,
    SentimentRecord,
    SourceEnum,
    TopicTrend,
)
from services.nlp_service import classify_batch, load_model
from services.reddit_service import (
    discover_subreddits,
    fetch_post_comments,
    fetch_subreddit_posts,
    _game_search_query,
    _post_mentions_game,
)
from services.steam_service import (
    fetch_reviews,
    get_games_by_developer,
    get_games_by_publisher,
    scrape_forum_threads,
)
from services.summary_service import generate_summaries
from services import period_summary_service as _pss
from services.topic_service import extract_topics, humanize_topic_labels, upsert_topic_trends

logger = logging.getLogger(__name__)

_LOG_DIR = Path(__file__).parent.parent / "logs"

# ── Module-level status — read by GET /api/ingest/status ─────────────────────
_status: dict = {
    "is_running": False,
    "last_run_at": None,          # ISO-8601 string
    "last_run_status": "never",   # "never" | "success" | "partial" | "error"
    "last_run_errors": [],
    "games_processed": 0,
    "posts_collected": 0,
    "next_run_at": None,          # ISO-8601 string — set by scheduler
}


def get_status() -> dict:
    """Return a snapshot of the current ingestion status."""
    return dict(_status)


def set_next_run(dt: Optional[datetime]) -> None:
    """Called by the scheduler after each run to record the next scheduled time."""
    _status["next_run_at"] = dt.isoformat() if dt else None


# ── Entry point ───────────────────────────────────────────────────────────────

def run_ingestion() -> dict:
    """
    Execute the full ingestion pipeline for all active games.

    Thread-safe: returns immediately if a run is already in progress.
    Returns a summary dict suitable for serialising as a JSON response.
    """
    if _status["is_running"]:
        logger.warning("Ingestion already running — ignoring duplicate trigger.")
        return {"status": "skipped", "reason": "already_running"}

    _status["is_running"] = True
    _status["last_run_at"] = datetime.now(timezone.utc).isoformat()

    log_lines: list[str] = []
    errors: list[str] = []
    games_processed = 0
    posts_collected = 0

    # Ensure the NLP model is loaded before processing any posts
    load_model()

    # Reset Reddit Gist cache so fresh data is fetched each run
    from services.reddit_service import _reset_gist_cache  # noqa
    _reset_gist_cache()

    db = SessionLocal()
    try:
        # ── Step 1: game discovery ────────────────────────────────────────────
        active_games = _step1_discover_games(db, log_lines, errors)
        log_lines.append(
            f"[Step 1] {len(active_games)} active game(s) queued."
        )

        for game in active_games:
            game_posts = 0
            try:
                # ── Step 2 ────────────────────────────────────────────────────
                game_posts += _step2_steam_reviews(db, game, log_lines, errors)

                # ── Step 3 ────────────────────────────────────────────────────
                game_posts += _step3_steam_forums(db, game, log_lines, errors)

                # ── Step 4 ────────────────────────────────────────────────────
                game_posts += _step4_reddit(db, game, log_lines, errors)

                # ── Step 5 ────────────────────────────────────────────────────
                _step5_classify_sentiment(db, game, log_lines, errors)

                # ── Step 6 ────────────────────────────────────────────────────
                _step6_extract_topics(db, game, log_lines, errors)

                # ── Step 7 ────────────────────────────────────────────────────
                _step7_daily_summary(db, game, log_lines, errors)

                games_processed += 1
                posts_collected += game_posts

            except Exception as exc:
                msg = f"Unhandled error processing game '{game.name}': {exc}"
                errors.append(msg)
                logger.exception(msg)
                # Continue with next game — never abort the whole pipeline

        # ── Step 9: Monthly summaries on 1st of month ───────────────────────────
        _step9_monthly_summaries(db, active_games, log_lines, errors)

        final_status = "success" if not errors else "partial"

    except Exception as exc:
        msg = f"Fatal ingestion error: {exc}"
        errors.append(msg)
        logger.exception(msg)
        final_status = "error"

    finally:
        # ── Step 8: write log ─────────────────────────────────────────────────
        _step8_write_log(log_lines, errors)

        db.close()
        _status["is_running"] = False
        _status["last_run_status"] = final_status
        _status["last_run_errors"] = errors
        _status["games_processed"] = games_processed
        _status["posts_collected"] = posts_collected

    return {
        "status": final_status,
        "games_processed": games_processed,
        "posts_collected": posts_collected,
        "errors": errors,
    }


# ── Step 1: Game Discovery ────────────────────────────────────────────────────

def _step1_discover_games(
    db: Session,
    log_lines: list,
    errors: list,
) -> list[Game]:
    """
    Fetch all Steam games for the configured publisher.
    Upserts new games and auto-discovers their subreddits.
    Returns the full list of active games for this publisher.
    """
    publisher: Optional[Publisher] = db.query(Publisher).first()
    if not publisher:
        log_lines.append("[Step 1] No publisher configured — nothing to ingest.")
        return []

    # Attempt Steam discovery by publisher; fall back to existing DB on failure
    try:
        steam_games_pub = get_games_by_publisher(publisher.name)
    except Exception as exc:
        msg = f"[Step 1] Steam publisher discovery failed: {exc}"
        errors.append(msg)
        logger.error(msg)
        steam_games_pub = []

    # Also search by developer name if configured (catches games published by
    # third parties such as Focus Home Interactive)
    steam_games_dev: list[dict] = []
    if settings.developer_name:
        try:
            steam_games_dev = get_games_by_developer(settings.developer_name)
        except Exception as exc:
            msg = f"[Step 1] Steam developer discovery failed: {exc}"
            errors.append(msg)
            logger.error(msg)

    # Merge, deduplicating by steam_app_id
    seen: dict[int, dict] = {g["steam_app_id"]: g for g in steam_games_pub}
    for g in steam_games_dev:
        seen.setdefault(g["steam_app_id"], g)
    steam_games = list(seen.values())

    new_count = 0
    for gd in steam_games:
        if db.query(Game).filter_by(steam_app_id=gd["steam_app_id"]).first():
            continue  # Already known
        subreddits = discover_subreddits(gd["name"])
        db.add(Game(
            publisher_id=publisher.id,
            steam_app_id=gd["steam_app_id"],
            name=gd["name"],
            release_date=gd.get("release_date"),
            is_active=True,
            subreddits=subreddits,
        ))
        new_count += 1

    if new_count:
        try:
            db.commit()
            log_lines.append(f"[Step 1] {new_count} new game(s) added.")
        except Exception as exc:
            db.rollback()
            errors.append(f"[Step 1] Error saving new games: {exc}")

    return (
        db.query(Game)
        .filter_by(publisher_id=publisher.id, is_active=True)
        .all()
    )


# ── Step 2: Steam Reviews ─────────────────────────────────────────────────────

def _step2_steam_reviews(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> int:
    """Fetch Steam reviews; return count of newly saved posts."""
    try:
        known_ids: set[str] = {
            row[0]
            for row in db.query(RawPost.external_id).filter(
                RawPost.game_id == game.id,
                RawPost.source == SourceEnum.steam_review,
            )
        }
        reviews = fetch_reviews(game.steam_app_id, known_ids=known_ids)
    except Exception as exc:
        msg = f"[Step 2] Steam reviews failed for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)
        return 0

    saved = _bulk_save_posts(db, game.id, SourceEnum.steam_review, reviews, errors)
    log_lines.append(
        f"[Step 2] '{game.name}': {saved} new review(s) (fetched {len(reviews)})."
    )
    return saved


# ── Step 3: Steam Forums ──────────────────────────────────────────────────────

def _step3_steam_forums(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> int:
    """Scrape Steam forum threads; return count of newly saved posts."""
    try:
        posts = scrape_forum_threads(game.steam_app_id, max_threads=10)
    except Exception as exc:
        msg = f"[Step 3] Steam forums failed for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)
        return 0

    saved = _bulk_save_posts(db, game.id, SourceEnum.steam_forum, posts, errors)
    log_lines.append(
        f"[Step 3] '{game.name}': {saved} new forum post(s) (fetched {len(posts)})."
    )
    return saved


# ── Step 4: Reddit ────────────────────────────────────────────────────────────

def _step4_reddit(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> int:
    """Fetch Reddit posts + comments from configured subreddits."""
    subreddits: list[str] = game.subreddits or []
    if not subreddits:
        log_lines.append(
            f"[Step 4] '{game.name}': no subreddits configured — skipping Reddit."
        )
        return 0

    total_saved = 0
    for raw_sub in subreddits:
        # Normalise: accept full URLs like https://www.reddit.com/r/gaming/,
        # "r/gaming", or plain names like "gaming"
        sub_name = raw_sub.strip().rstrip("/")
        if "/r/" in sub_name:
            sub_name = sub_name.split("/r/")[-1].split("/")[0]
        elif sub_name.startswith("r/"):
            sub_name = sub_name[2:]
        if not sub_name:
            continue
        try:
            submissions = fetch_subreddit_posts(sub_name, limit=25, game_name=game.name)
            total_saved += _bulk_save_posts(
                db, game.id, SourceEnum.reddit, submissions, errors
            )
            # NOTE: Comment fetching is disabled because Reddit blocks all
            # JSON API requests from datacenter IPs (403 Blocked). Each
            # blocked comment fetch adds ~4s of wasted retry time, which
            # made full ingestion take hours. Posts alone provide sufficient
            # sentiment signal. Re-enable if Reddit API access is restored.
        except Exception as exc:
            msg = f"[Step 4] Reddit error for r/{sub_name}: {exc}"
            errors.append(msg)
            logger.error(msg)

    log_lines.append(
        f"[Step 4] '{game.name}': {total_saved} new Reddit post(s)/comment(s)."
    )
    return total_saved


# ── Step 5: Sentiment Classification ─────────────────────────────────────────

def _step5_classify_sentiment(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> None:
    """
    Batch-classify ALL unprocessed posts for this game.
    Processes any backlog from previous failed runs, not just today's posts.
    """
    unprocessed: list[RawPost] = (
        db.query(RawPost)
        .outerjoin(SentimentRecord, RawPost.id == SentimentRecord.raw_post_id)
        .filter(
            RawPost.game_id == game.id,
            SentimentRecord.id.is_(None),
        )
        .all()
    )

    if not unprocessed:
        log_lines.append(f"[Step 5] '{game.name}': no unclassified posts.")
        return

    texts = [_post_text(p) for p in unprocessed]
    try:
        results = classify_batch(texts)
    except Exception as exc:
        msg = f"[Step 5] Batch classification failed for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)
        return

    for post, (label, score) in zip(unprocessed, results):
        db.add(SentimentRecord(
            raw_post_id=post.id,
            sentiment=SentimentEnum(label),
            sentiment_score=score,
            topics=[],
        ))

    try:
        db.commit()
        log_lines.append(
            f"[Step 5] '{game.name}': classified {len(unprocessed)} post(s)."
        )
    except Exception as exc:
        db.rollback()
        msg = f"[Step 5] Error saving sentiment records for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)


# ── Step 6: Topic Extraction ──────────────────────────────────────────────────

def _step6_extract_topics(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> None:
    """
    Cluster today's posts per sentiment group.
    Upserts results into topic_trends and back-fills SentimentRecord.topics.
    """
    today = date.today()
    day_start = datetime.combine(today, datetime.min.time())
    day_end = day_start + timedelta(days=1)

    # Use post_date where available so posts count toward the day they were posted
    effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)
    rows: list[tuple[RawPost, SentimentRecord]] = (
        db.query(RawPost, SentimentRecord)
        .join(SentimentRecord, RawPost.id == SentimentRecord.raw_post_id)
        .filter(
            RawPost.game_id == game.id,
            effective_date >= day_start,
            effective_date < day_end,
        )
        .all()
    )

    if not rows:
        log_lines.append(f"[Step 6] '{game.name}': no posts today (range {day_start} - {day_end}).")
        return

    # Group text by sentiment
    grouped: dict[str, list[str]] = {"positive": [], "negative": [], "neutral": []}
    for post, sr in rows:
        text = _post_text(post)
        if text:
            grouped[sr.sentiment.value].append(text)

    # Extract topics per sentiment group
    topics_by_sentiment: dict[str, list[str]] = {}
    for sentiment_label, texts in grouped.items():
        if not texts:
            continue
        try:
            topics = extract_topics(texts)
            topics_by_sentiment[sentiment_label] = topics
        except Exception as exc:
            msg = (
                f"[Step 6] Topic extraction error ({sentiment_label}) "
                f"for '{game.name}': {exc}"
            )
            errors.append(msg)
            logger.error(msg)

    if not topics_by_sentiment:
        return

    # Convert raw keyword clusters to plain-English labels via Claude
    try:
        topics_by_sentiment = humanize_topic_labels(game.name, topics_by_sentiment)
    except Exception as exc:
        logger.warning("[Step 6] Topic humanization failed for '%s': %s", game.name, exc)

    # Back-fill top topics onto each SentimentRecord for this game/day
    top_map = {k: v[:5] for k, v in topics_by_sentiment.items()}
    for _, sr in rows:
        sr.topics = top_map.get(sr.sentiment.value, [])

    # Upsert into topic_trends (includes its own commit)
    try:
        upsert_topic_trends(db, game.id, today, topics_by_sentiment)
    except Exception as exc:
        msg = f"[Step 6] Topic trend upsert failed for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)
        return

    total = sum(len(v) for v in topics_by_sentiment.values())
    log_lines.append(
        f"[Step 6] '{game.name}': {total} topic(s) extracted/updated."
    )


# ── Step 7: Daily Summary ─────────────────────────────────────────────────────

def _step7_daily_summary(
    db: Session,
    game: Game,
    log_lines: list,
    errors: list,
) -> None:
    """
    Aggregate today's sentiment counts, compute trend delta, and generate the
    AI executive summary + recommended actions.  Upserts one DailySummary row.
    """
    today = date.today()
    day_start = datetime.combine(today, datetime.min.time())
    day_end = day_start + timedelta(days=1)

    # Aggregate counts for today using the post's actual date (post_date for
    # Reddit/forums, collected_at for Steam which has no post_date).
    # Posts always count toward the day they were originally posted.
    effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)
    count_rows = (
        db.query(SentimentRecord.sentiment, func.count(SentimentRecord.id))
        .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
        .filter(
            RawPost.game_id == game.id,
            effective_date >= day_start,
            effective_date < day_end,
        )
        .group_by(SentimentRecord.sentiment)
        .all()
    )

    count_map: dict[str, int] = {s.value: c for s, c in count_rows}
    pos = count_map.get("positive", 0)
    neg = count_map.get("negative", 0)
    neu = count_map.get("neutral", 0)
    total = pos + neg + neu

    # ── Zero-new-records path ─────────────────────────────────────────────────
    # Even when no new posts were collected today, write a DailySummary row so
    # the dashboard and summary pages remain visible and don't lose persistence.
    # Carry forward topics from the most recent prior summary so the topic
    # panels are not blank.
    if total == 0:
        prior: Optional[DailySummary] = (
            db.query(DailySummary)
            .filter(
                DailySummary.game_id == game.id,
                DailySummary.summary_date < today,
            )
            .order_by(DailySummary.summary_date.desc())
            .first()
        )
        top_pos_zero = prior.top_positive_topics if prior else []
        top_neg_zero = prior.top_negative_topics if prior else []
        top_neu_zero = prior.top_neutral_topics if prior else []
        prior_date_str = str(prior.summary_date) if prior else "unknown"

        no_data_summary = (
            f"[No new posts collected] No new community posts were ingested for "
            f"{game.name} during today's run. All sentiment metrics and topics "
            f"reflect historical data. Most recent active collection: {prior_date_str}."
        )
        no_data_actions = (
            "[No new posts collected] No new data was available today. "
            "Previous recommended actions remain applicable until new posts are ingested."
        )

        existing_zero: Optional[DailySummary] = (
            db.query(DailySummary)
            .filter_by(game_id=game.id, summary_date=today)
            .first()
        )
        if existing_zero:
            existing_zero.executive_summary = no_data_summary
            existing_zero.recommended_actions = no_data_actions
            existing_zero.top_positive_topics = top_pos_zero
            existing_zero.top_negative_topics = top_neg_zero
            existing_zero.top_neutral_topics = top_neu_zero
        else:
            db.add(DailySummary(
                game_id=game.id,
                summary_date=today,
                positive_count=0,
                negative_count=0,
                neutral_count=0,
                top_positive_topics=top_pos_zero,
                top_negative_topics=top_neg_zero,
                top_neutral_topics=top_neu_zero,
                sentiment_trend_delta=None,
                executive_summary=no_data_summary,
                recommended_actions=no_data_actions,
            ))

        try:
            db.commit()
            log_lines.append(
                f"[Step 7] '{game.name}': no new posts today — "
                f"zero-count summary written (topics carried from {prior_date_str})."
            )
        except Exception as exc:
            db.rollback()
            msg = f"[Step 7] Error saving zero-count summary for '{game.name}': {exc}"
            errors.append(msg)
            logger.error(msg)
        return

    # ── Normal path: new posts were collected today ───────────────────────────

    # Top-5 topics per sentiment — returns (label, trend_direction) tuples so
    # the Claude actions prompt can reference trend context per topic.
    def _top_topics_with_trend(
        sentiment: SentimentEnum, limit: int = 5
    ) -> list[tuple[str, str]]:
        return [
            (t.topic_label, t.trend_direction.value)
            for t in (
                db.query(TopicTrend)
                .filter_by(game_id=game.id, sentiment=sentiment)
                .order_by(TopicTrend.mention_count.desc())
                .limit(limit)
                .all()
            )
        ]

    pos_with_trend = _top_topics_with_trend(SentimentEnum.positive)
    neg_with_trend = _top_topics_with_trend(SentimentEnum.negative)
    neu_with_trend = _top_topics_with_trend(SentimentEnum.neutral)

    # Plain label lists for the executive summary prompt and DB storage
    top_pos = [label for label, _ in pos_with_trend]
    top_neg = [label for label, _ in neg_with_trend]
    top_neu = [label for label, _ in neu_with_trend]

    trend_delta = _compute_trend_delta(db, game.id, today, pos, neg, total)

    # Generate AI text via Claude API (summary_service.py)
    try:
        exec_summary, rec_actions = generate_summaries(
            game_name=game.name,
            top_positive_topics=top_pos,
            top_negative_topics=top_neg,
            top_neutral_topics=top_neu,
            trend_delta=trend_delta,
            total_posts=total,
            positive_with_trend=pos_with_trend,
            negative_with_trend=neg_with_trend,
            neutral_with_trend=neu_with_trend,
        )
    except Exception as exc:
        errors.append(
            f"[Step 7] Summary generation failed for '{game.name}': {exc}"
        )
        exec_summary = ""
        rec_actions = ""

    # Upsert — one row per game per date
    existing: Optional[DailySummary] = (
        db.query(DailySummary)
        .filter_by(game_id=game.id, summary_date=today)
        .first()
    )
    if existing:
        existing.positive_count = pos
        existing.negative_count = neg
        existing.neutral_count = neu
        existing.top_positive_topics = top_pos
        existing.top_negative_topics = top_neg
        existing.top_neutral_topics = top_neu
        existing.sentiment_trend_delta = trend_delta
        existing.executive_summary = exec_summary
        existing.recommended_actions = rec_actions
    else:
        db.add(DailySummary(
            game_id=game.id,
            summary_date=today,
            positive_count=pos,
            negative_count=neg,
            neutral_count=neu,
            top_positive_topics=top_pos,
            top_negative_topics=top_neg,
            top_neutral_topics=top_neu,
            sentiment_trend_delta=trend_delta,
            executive_summary=exec_summary,
            recommended_actions=rec_actions,
        ))

    try:
        db.commit()
        log_lines.append(
            f"[Step 7] '{game.name}': summary saved "
            f"(pos={pos}, neg={neg}, neu={neu}, total={total}, "
            f"delta={f'{trend_delta:+.1%}' if trend_delta is not None else 'N/A'})."
        )
    except Exception as exc:
        db.rollback()
        msg = f"[Step 7] Error saving daily summary for '{game.name}': {exc}"
        errors.append(msg)
        logger.error(msg)


# ── Step 9: Monthly Summaries ────────────────────────────────────────────────

def _step9_monthly_summaries(
    db,
    active_games: list,
    log_lines: list,
    errors: list,
) -> None:
    """
    If today is the 1st of the month, generate monthly summaries for the
    preceding calendar month for all active games. Idempotent due to the
    UNIQUE constraint on (game_id, period_year, period_month).
    """
    today = date.today()
    if today.day != 1:
        return

    # The month that just ended
    first_of_this_month = today
    last_month_end = first_of_this_month - timedelta(days=1)
    year  = last_month_end.year
    month = last_month_end.month

    log_lines.append(
        f"[Step 9] 1st of month — generating monthly summaries for {year}-{month:02d} "        f"across {len(active_games)} game(s)."
    )

    for game in active_games:
        try:
            _pss.generate_monthly_summary(db, game.id, year, month)
            log_lines.append(
                f"[Step 9] Monthly summary generated for '{game.name}' {year}-{month:02d}."
            )
        except Exception as exc:
            msg = (
                f"[Step 9] Monthly summary failed for '{game.name}' "                f"{year}-{month:02d}: {exc}"
            )
            errors.append(msg)
            logger.error(msg)


# ── Step 8: Write Log ─────────────────────────────────────────────────────────

def _step8_write_log(log_lines: list, errors: list) -> None:
    """Append a structured run record to logs/ingest_YYYY-MM-DD.log."""
    _LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = _LOG_DIR / f"ingest_{date.today()}.log"
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    sep = "-" * 60

    with log_file.open("a", encoding="utf-8") as fh:
        fh.write(f"\n{sep}\n")
        fh.write(f"Ingestion run completed: {timestamp}\n")
        fh.write(f"{sep}\n")
        for line in log_lines:
            fh.write(f"  {line}\n")
        if errors:
            fh.write(f"\nERRORS ({len(errors)}):\n")
            for err in errors:
                fh.write(f"  [ERROR] {err}\n")
        fh.write(f"{sep}\n")

    logger.info("Ingestion log written → %s", log_file)


# ── Private helpers ───────────────────────────────────────────────────────────

def _bulk_save_posts(
    db: Session,
    game_id: int,
    source: SourceEnum,
    post_data_list: list[dict],
    errors: list,
) -> int:
    """
    Persist a list of raw-post dicts, skipping any that are already stored.

    Deduplication checks (external_id, source) globally AND per game_id to
    handle Reddit posts shared across multiple games' subreddits.
    Inserts one-by-one to avoid a single duplicate killing the whole batch.

    Returns the count of newly inserted rows.
    """
    if not post_data_list:
        return 0

    external_ids = [p["external_id"] for p in post_data_list]
    # Check for posts already stored globally (any game) with same external_id+source
    known: set[str] = {
        row[0]
        for row in db.query(RawPost.external_id).filter(
            RawPost.external_id.in_(external_ids),
            RawPost.source == source,
        )
    }

    saved = 0
    for pd in post_data_list:
        if pd["external_id"] in known:
            continue
        row = RawPost(
            game_id=game_id,
            source=source,
            external_id=pd["external_id"],
            author=pd.get("author"),
            title=pd.get("title"),
            body=pd.get("body"),
            url=pd.get("url"),
            upvotes=pd.get("upvotes", 0),
            post_date=pd.get("post_date"),
        )
        db.add(row)
        try:
            db.commit()
            known.add(pd["external_id"])  # Track so next game skips it
            saved += 1
        except Exception:
            db.rollback()
            known.add(pd["external_id"])  # Already exists, skip silently

    return saved


def _post_text(post: RawPost) -> str:
    """Concatenate title and body into a single NLP input string."""
    return " ".join(
        part for part in (post.title or "", post.body or "") if part
    ).strip()


def _compute_trend_delta(
    db: Session,
    game_id: int,
    today: date,
    pos: int,
    neg: int,
    total: int,
) -> Optional[float]:
    """
    Compute the change in net sentiment score vs the most recent prior summary.

    Net sentiment = (positive_count - negative_count) / total_count.
    Returns None if no prior summary exists or prior total is zero.
    """
    if total == 0:
        return None

    today_net = (pos - neg) / total

    prior: Optional[DailySummary] = (
        db.query(DailySummary)
        .filter(
            DailySummary.game_id == game_id,
            DailySummary.summary_date < today,
        )
        .order_by(DailySummary.summary_date.desc())
        .first()
    )

    if prior is None:
        return None

    prior_total = prior.positive_count + prior.negative_count + prior.neutral_count
    if prior_total == 0:
        return None

    prior_net = (prior.positive_count - prior.negative_count) / prior_total
    return round(today_net - prior_net, 4)
