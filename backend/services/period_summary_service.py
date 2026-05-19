"""
Period-based summary generation service.

Provides:
  - generate_monthly_summary(db, game_id, year, month) -> MonthlySummary
  - generate_window_summary(db, game_id, days=7) -> WindowSummary

Both call Claude via _call_claude_for_period() which is cache-unaware;
the caching layer is implemented here before calling Claude.

Bold ideas: gracefully returns [] when Claude responds with "NONE".
"""
import logging
import re
from calendar import monthrange
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from config import settings
from models import (
    Game,
    MonthlySummary,
    RawPost,
    SentimentEnum,
    SentimentRecord,
    WindowSummary,
)

logger = logging.getLogger(__name__)

_MODEL = "claude-haiku-4-5-20251001"
_MAX_TOKENS_SUMMARY = 500
_MAX_TOKENS_ACTIONS = 700
_MAX_TOKENS_BOLD = 400

MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


# ── Public API ────────────────────────────────────────────────────────────────

def generate_monthly_summary(
    db: Session,
    game_id: int,
    year: int,
    month: int,
) -> MonthlySummary:
    """
    Generate (or return existing) a MonthlySummary for (game_id, year, month).

    Window covers [first-of-month, last-of-month] inclusive, using
    COALESCE(post_date, collected_at) to assign each post to the day it was posted.
    """
    game: Optional[Game] = db.query(Game).filter_by(id=game_id).first()
    if not game:
        raise ValueError(f"Game {game_id} not found.")

    # Build window dates
    _, last_day = monthrange(year, month)
    window_start = date(year, month, 1)
    window_end   = date(year, month, last_day)

    window_label = f"{MONTH_NAMES[month]} {year}"

    # Compute stats
    pos, neg, neu, top_pos, top_neg, top_neu = _aggregate_posts(
        db, game_id, window_start, window_end
    )
    total = pos + neg + neu

    # Call Claude (even if total==0; let the LLM handle sparse data gracefully)
    exec_summary, rec_actions, bold_ideas = _call_claude_for_period(
        game_name=game.name,
        window_label=window_label,
        pos_topics=top_pos,
        neg_topics=top_neg,
        neu_topics=top_neu,
        total_posts=total,
    )

    # Upsert
    existing: Optional[MonthlySummary] = (
        db.query(MonthlySummary)
        .filter_by(game_id=game_id, period_year=year, period_month=month)
        .first()
    )
    if existing:
        existing.positive_count = pos
        existing.negative_count = neg
        existing.neutral_count = neu
        existing.total_posts = total
        existing.top_positive_topics = top_pos
        existing.top_negative_topics = top_neg
        existing.top_neutral_topics = top_neu
        existing.executive_summary = exec_summary
        existing.recommended_actions = rec_actions
        existing.bold_ideas = bold_ideas
        existing.generated_at = datetime.utcnow()
        row = existing
    else:
        row = MonthlySummary(
            game_id=game_id,
            period_year=year,
            period_month=month,
            positive_count=pos,
            negative_count=neg,
            neutral_count=neu,
            total_posts=total,
            top_positive_topics=top_pos,
            top_negative_topics=top_neg,
            top_neutral_topics=top_neu,
            executive_summary=exec_summary,
            recommended_actions=rec_actions,
            bold_ideas=bold_ideas,
        )
        db.add(row)

    db.commit()
    db.refresh(row)
    logger.info(
        "Monthly summary for game=%d %s: pos=%d neg=%d neu=%d total=%d bold=%d",
        game_id, window_label, pos, neg, neu, total, len(bold_ideas or [])
    )
    return row


def generate_window_summary(
    db: Session,
    game_id: int,
    days: int = 7,
) -> WindowSummary:
    """
    Return (cache-hit) or generate a WindowSummary for (game_id, days).

    Finds the latest ingest_date by querying MAX(COALESCE(post_date, collected_at))
    from raw_posts for this game. Window covers [ingest_date - days + 1, ingest_date].

    Cache: if a WindowSummary already exists for (game_id, days, ingest_date), return it.
    """
    game: Optional[Game] = db.query(Game).filter_by(id=game_id).first()
    if not game:
        raise ValueError(f"Game {game_id} not found.")

    effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)

    # Find the latest date with posts for this game
    max_dt = (
        db.query(func.max(effective_date))
        .filter(RawPost.game_id == game_id)
        .scalar()
    )

    if max_dt is None:
        # No posts at all — use today as anchor
        ingest_date = date.today()
    elif isinstance(max_dt, datetime):
        ingest_date = max_dt.date()
    elif isinstance(max_dt, date):
        ingest_date = max_dt
    else:
        ingest_date = date.today()

    # Cache lookup
    cached: Optional[WindowSummary] = (
        db.query(WindowSummary)
        .filter_by(game_id=game_id, window_days=days, ingest_date=ingest_date)
        .first()
    )
    if cached:
        logger.info(
            "Window summary cache HIT: game=%d days=%d ingest_date=%s",
            game_id, days, ingest_date
        )
        return cached

    # Generate
    window_start = ingest_date - timedelta(days=days - 1)
    window_end   = ingest_date

    # Build window label for Claude prompt
    start_str = window_start.strftime("%-d %b")
    end_str   = ingest_date.strftime("%-d %b, %Y")
    window_label = f"Past {days} days · {start_str} – {end_str}"

    pos, neg, neu, top_pos, top_neg, top_neu = _aggregate_posts(
        db, game_id, window_start, window_end
    )
    total = pos + neg + neu

    exec_summary, rec_actions, bold_ideas = _call_claude_for_period(
        game_name=game.name,
        window_label=window_label,
        pos_topics=top_pos,
        neg_topics=top_neg,
        neu_topics=top_neu,
        total_posts=total,
    )

    row = WindowSummary(
        game_id=game_id,
        window_days=days,
        ingest_date=ingest_date,
        positive_count=pos,
        negative_count=neg,
        neutral_count=neu,
        total_posts=total,
        top_positive_topics=top_pos,
        top_negative_topics=top_neg,
        top_neutral_topics=top_neu,
        executive_summary=exec_summary,
        recommended_actions=rec_actions,
        bold_ideas=bold_ideas,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    logger.info(
        "Window summary MISS → generated: game=%d days=%d ingest_date=%s total=%d",
        game_id, days, ingest_date, total
    )
    return row


# ── Internal helpers ──────────────────────────────────────────────────────────

def _aggregate_posts(
    db: Session,
    game_id: int,
    window_start: date,
    window_end: date,
) -> tuple[int, int, int, list[str], list[str], list[str]]:
    """
    Aggregate sentiment counts and top-5 topics for the given date window.

    Returns (pos, neg, neu, top_positive, top_negative, top_neutral).
    Uses COALESCE(post_date, collected_at) for date filtering.
    """
    # Convert dates to datetimes for comparison with DateTime columns
    start_dt = datetime.combine(window_start, datetime.min.time())
    end_dt   = datetime.combine(window_end,   datetime.max.time())

    effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)

    count_rows = (
        db.query(SentimentRecord.sentiment, func.count(SentimentRecord.id))
        .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
        .filter(
            RawPost.game_id == game_id,
            effective_date >= start_dt,
            effective_date <= end_dt,
        )
        .group_by(SentimentRecord.sentiment)
        .all()
    )

    count_map: dict[str, int] = {s.value: c for s, c in count_rows}
    pos = count_map.get("positive", 0)
    neg = count_map.get("negative", 0)
    neu = count_map.get("neutral", 0)

    # Collect top-5 topics per sentiment from SentimentRecord.topics (JSON lists)
    def _top_topics(sentiment: SentimentEnum) -> list[str]:
        rows = (
            db.query(SentimentRecord.topics)
            .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
            .filter(
                RawPost.game_id == game_id,
                SentimentRecord.sentiment == sentiment,
                effective_date >= start_dt,
                effective_date <= end_dt,
            )
            .all()
        )
        freq: dict[str, int] = {}
        for (topics,) in rows:
            for topic in (topics or []):
                freq[topic] = freq.get(topic, 0) + 1
        return [t for t, _ in sorted(freq.items(), key=lambda x: -x[1])[:5]]

    top_pos = _top_topics(SentimentEnum.positive)
    top_neg = _top_topics(SentimentEnum.negative)
    top_neu = _top_topics(SentimentEnum.neutral)

    return pos, neg, neu, top_pos, top_neg, top_neu


def _call_claude_for_period(
    game_name: str,
    window_label: str,
    pos_topics: list[str],
    neg_topics: list[str],
    neu_topics: list[str],
    total_posts: int,
) -> tuple[str, str, list[str]]:
    """
    Call Claude for (exec_summary, recommended_actions, bold_ideas).

    Returns placeholder strings if the API key is missing or calls fail.
    bold_ideas: list[str] — empty list when Claude returns "NONE".
    """
    client = _get_client()
    if client is None:
        return (
            _placeholder_summary(game_name, window_label, total_posts),
            _placeholder_actions(),
            [],
        )

    pos_str = ", ".join(pos_topics) if pos_topics else "none identified"
    neg_str = ", ".join(neg_topics) if neg_topics else "none identified"
    neu_str = ", ".join(neu_topics) if neu_topics else "none identified"

    exec_summary  = _call_exec(client, game_name, window_label, pos_str, neg_str, neu_str, total_posts)
    rec_actions   = _call_actions(client, game_name, window_label, pos_str, neg_str, neu_str)
    bold_ideas    = _call_bold_ideas(client, game_name, window_label, pos_str, neg_str, neu_str, total_posts)

    return exec_summary, rec_actions, bold_ideas


def _call_exec(client, game_name, window_label, pos_str, neg_str, neu_str, total_posts) -> str:
    prompt = (
        f'You are a game industry analyst writing for the leadership team about "{game_name}".\n\n'
        f"Below is community sentiment data covering {window_label}. Write a 4-6 sentence executive summary that is:\n"
        f"- SPECIFIC: cite topic names and rough magnitudes. Don't say \"users like the gameplay\" — say which topics rank where and how big the signal is relative to total posts.\n"
        f"- ACTIONABLE: lean toward observations that imply a decision or response.\n"
        f"- HONEST about scale: if total post volume is low, say so plainly.\n\n"
        f"Avoid generic platitudes, restating raw counts without insight, or hedging when the data is clear.\n\n"
        f"Data ({window_label}):\n"
        f"Top positive topics: {pos_str}\n"
        f"Top negative topics: {neg_str}\n"
        f"Top neutral topics: {neu_str}\n"
        f"Total posts analyzed: {total_posts}\n\n"
        f"Write only the summary paragraph. No bullet points, no headings."
    )
    try:
        message = client.messages.create(
            model=_MODEL,
            max_tokens=_MAX_TOKENS_SUMMARY,
            messages=[{"role": "user", "content": prompt}],
        )
        return message.content[0].text.strip()
    except Exception as exc:
        logger.error("Claude exec summary error for '%s': %s", game_name, exc)
        return _placeholder_summary(game_name, window_label, total_posts)


def _call_actions(client, game_name, window_label, pos_str, neg_str, neu_str) -> str:
    prompt = (
        f'You are a game community manager and product strategist for "{game_name}".\n\n'
        f"Based on the sentiment data from {window_label} below, write 3-5 specific, actionable recommendations "
        f"the team should execute next. Requirements:\n"
        f"- Each must reference a specific topic from the data\n"
        f"- Each must be concrete enough to put on a sprint board this week\n"
        f"- Where useful, note whether the issue looks worsening, stable, or an emerging positive to amplify\n"
        f"- If a category has nothing actionable, write fewer items rather than padding\n\n"
        f"Avoid generic advice.\n\n"
        f"Negative topics: {neg_str}\n"
        f"Neutral topics: {neu_str}\n"
        f"Positive topics: {pos_str}\n\n"
        f"Format as a numbered list. Each item one sentence, two max."
    )
    try:
        message = client.messages.create(
            model=_MODEL,
            max_tokens=_MAX_TOKENS_ACTIONS,
            messages=[{"role": "user", "content": prompt}],
        )
        return message.content[0].text.strip()
    except Exception as exc:
        logger.error("Claude actions error for '%s': %s", game_name, exc)
        return _placeholder_actions()


def _call_bold_ideas(client, game_name, window_label, pos_str, neg_str, neu_str, total_posts) -> list[str]:
    prompt = (
        f'You are a creative game marketing strategist for "{game_name}". '
        f"Looking at community signals from {window_label}, find opportunities that a typical analyst would MISS.\n\n"
        f"ONLY if you spot something genuinely worth flagging as a bold move — beyond the obvious fixes — "
        f"propose 1 or 2 \"bold ideas to consider.\" They should be:\n"
        f"- Surprising or non-obvious (a community event, an unexpected partnership angle, a creative response to a complaint cluster)\n"
        f"- Tied to specific signals in the data\n"
        f"- Aimed at driving positive sentiment in a way standard recommendations wouldn't\n\n"
        f"If the data does NOT clearly support a bold idea, respond with the literal string \"NONE\" and nothing else. "
        f"Most periods should return NONE. Only fire when there's a real signal.\n\n"
        f"Data ({window_label}):\n"
        f"Positive topics: {pos_str}\n"
        f"Negative topics: {neg_str}\n"
        f"Neutral topics: {neu_str}\n"
        f"Total posts: {total_posts}\n\n"
        f"Format if ideas exist:\n"
        f"1. <Bold idea, 1-2 sentences, specific, references data>\n"
        f"2. <Optional second>\n\n"
        f"Otherwise respond with: NONE"
    )
    try:
        message = client.messages.create(
            model=_MODEL,
            max_tokens=_MAX_TOKENS_BOLD,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text.strip()
        return _parse_bold_ideas(raw)
    except Exception as exc:
        logger.error("Claude bold ideas error for '%s': %s", game_name, exc)
        return []


def _parse_bold_ideas(raw: str) -> list[str]:
    """
    Parse Claude's bold ideas response.

    Returns [] when response is "NONE" (case-insensitive, trimmed).
    Parses numbered list ("1. ...\n2. ...") into list[str].
    """
    if raw.strip().upper() == "NONE":
        return []

    # Try numbered list pattern
    items = re.findall(r"^\d+\.\s+(.+?)(?=\n\d+\.|\Z)", raw, re.MULTILINE | re.DOTALL)
    if items:
        return [item.strip() for item in items if item.strip()]

    # Fallback: split on newlines and filter empty
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    # Remove leading numbering if present
    cleaned = []
    for line in lines:
        cleaned.append(re.sub(r"^\d+\.\s*", "", line))
    return [c for c in cleaned if c]


# ── Claude client factory ─────────────────────────────────────────────────────

def _get_client():
    """Return an Anthropic client, or None if key is missing / package absent."""
    api_key = _resolve_api_key()
    if not api_key:
        logger.warning(
            "ANTHROPIC_API_KEY not configured — returning placeholder summaries."
        )
        return None
    try:
        import anthropic  # noqa: PLC0415
        return anthropic.Anthropic(
            api_key=api_key,
            base_url="https://api.anthropic.com",
        )
    except ImportError:
        logger.error("'anthropic' package not installed. Run: pip install anthropic")
        return None
    except Exception as exc:
        logger.error("Failed to initialise Anthropic client: %s", exc)
        return None


def _resolve_api_key() -> str:
    if settings.anthropic_api_key:
        return settings.anthropic_api_key
    try:
        import os
        from dotenv import dotenv_values

        services_dir = os.path.dirname(os.path.abspath(__file__))
        backend_dir  = os.path.dirname(services_dir)
        project_root = os.path.dirname(backend_dir)

        for env_path in (
            os.path.join(project_root, ".env"),
            os.path.join(backend_dir,  ".env"),
        ):
            if os.path.exists(env_path):
                key = dotenv_values(env_path).get("ANTHROPIC_API_KEY", "")
                if key:
                    return key
    except Exception:
        pass
    return ""


# ── Placeholder fallbacks ─────────────────────────────────────────────────────

def _placeholder_summary(game_name: str, window_label: str, total_posts: int) -> str:
    return (
        f"[AI summary unavailable — configure ANTHROPIC_API_KEY to enable.] "
        f"{total_posts} community posts were analysed for {game_name} during {window_label}."
    )


def _placeholder_actions() -> str:
    return (
        "1. [AI actions unavailable — configure ANTHROPIC_API_KEY to enable.]\n"
        "2. Review negative topics manually and prioritise high-velocity issues.\n"
        "3. Amplify positive community feedback through official channels."
    )
