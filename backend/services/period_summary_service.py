"""
Period-based summary generation service.

Provides:
  - generate_monthly_summary(db, game_id, year, month) -> MonthlySummary
  - generate_window_summary(db, game_id, days=7) -> WindowSummary

Both call Claude via _call_claude_for_period() which is cache-unaware;
the caching layer is implemented here before calling Claude.

Bold ideas: gracefully returns [] when Claude responds with "NONE".

1-day window special path: when days==1, topic aggregation bypasses the
cached SentimentRecord.topics (which are empty for single-day windows due to
the §15 critical-mass gate requiring ≥2 distinct days). Instead it calls
topic_service.extract_topics_with_metadata directly with a relaxed gate:
≥3 distinct posts AND ≥3 distinct authors (day-span requirement dropped).
See _aggregate_posts_1day() and CLAUDE.md §15 for details.
"""
import logging
import re
from calendar import monthrange
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from config import settings
from models import (
    DailySummary,
    Game,
    MonthlySummary,
    RawPost,
    SentimentEnum,
    SentimentRecord,
    WindowSummary,
)

logger = logging.getLogger(__name__)

_MODEL = "claude-haiku-4-5-20251001"
# Token budgets bumped 2026-06-24: the [P-NNN] citation tokens added by
# CLAUDE.md §20 layer 3 consume ~25 tokens per text block (3-5 sentences
# each ending with a citation).  Without the bump, the LLM was being
# squeezed and returning fewer/shorter items than before citation
# grounding.  These ceilings give the model headroom to produce the same
# content density as pre-§20 plus the new citations.
_MAX_TOKENS_SUMMARY = 700
# Tightened from 700 → 350 to discourage verbose multi-clause recommendations.
# With the 25-word-per-item budget, 5 items × ~40 tokens = 200 tokens; 350 leaves
# comfortable headroom while still capping runaway prose.
_MAX_TOKENS_ACTIONS = 600
_MAX_TOKENS_BOLD = 600

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

    # Specifics-extraction (2026-05-30 hardening): pull real post samples and
    # surface distinctive entities so the summary can name specific events,
    # DLCs, levels, weapons, etc. — not just generic topic buckets.
    # CLAUDE.md §20 (2026-06-24): also pull the with-ids variant so the
    # citation grounding + self-criticism layers can verify every claim.
    sample_posts_with_ids = _sample_posts_with_ids(db, game_id, window_start, window_end)
    sample_posts = {k: [p["text"] for p in v] for k, v in sample_posts_with_ids.items()}
    distinctive = _distinctive_entities(sample_posts)

    # CLAUDE.md §21b: critical-mass tiers for the monthly window.
    cm_table = _topic_critical_mass_table(db, game_id, window_start, window_end)

    # CLAUDE.md §24: fetch (or reuse cached) editorial articles for this
    # monthly cycle.  Safe to run with total<MIN_SUBSTANTIVE_POSTS — the
    # editorial cache key is on the cycle, not the post volume.  When
    # _call_claude_for_period decides to skip Claude (§15 insufficient-
    # signal sentinel), the editorial articles aren't used; that's fine.
    editorial_articles = _safe_fetch_editorial(
        db, game_id=game_id, scope="monthly",
        cycle_start=window_start, cycle_end=window_end,
    )

    # Call Claude (even if total==0; let the LLM handle sparse data gracefully)
    exec_summary, rec_actions, bold_ideas, citation_map = _call_claude_for_period(
        game_name=game.name,
        window_label=window_label,
        pos_topics=top_pos,
        neg_topics=top_neg,
        neu_topics=top_neu,
        pos_count=pos,
        neg_count=neg,
        neu_count=neu,
        sample_posts=sample_posts,
        distinctive_entities=distinctive,
        sample_posts_with_ids=sample_posts_with_ids,
        commercial_context=game.commercial_context,
        critical_mass_table=cm_table,
        editorial_articles=editorial_articles,
        demographic_context=game.demographic_context,
    )

    # CLAUDE.md §22: pre-flight QA + max-count safety net.
    failures = _validate_summary_output(
        exec_summary=exec_summary,
        recommended_actions=rec_actions,
        bold_ideas=bold_ideas,
        citation_map=citation_map,
        total_posts=total,
        critical_mass_table=cm_table,
    )
    for f in failures:
        logger.warning("§22 pre-flight QA flagged (game_id=%d monthly %d-%02d): %s", game_id, year, month, f)
    rec_actions = _truncate_to_max_recommendations(rec_actions)

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
        existing.citation_map = citation_map or None
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
            citation_map=citation_map or None,
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

    # §15 conflict-resolution: a 1-day window can never satisfy the ≥2-day-span
    # requirement in the nightly _step6_extract_topics gate, so
    # SentimentRecord.topics will always be empty for posts on a single day.
    # When days==1 we bypass the cached topics entirely and run a RELAXED topic
    # extraction directly on the day's posts (≥3 posts AND ≥3 authors, no
    # day-span requirement). Multi-day windows keep the existing cached path.
    # See CLAUDE.md §15 for the full critical-mass gate specification.
    if days == 1:
        pos, neg, neu, top_pos, top_neg, top_neu = _aggregate_posts_1day(
            db, game_id, ingest_date
        )
    else:
        pos, neg, neu, top_pos, top_neg, top_neu = _aggregate_posts(
            db, game_id, window_start, window_end
        )
    total = pos + neg + neu

    # Specifics-extraction (2026-05-30 hardening): same as monthly path.
    # CLAUDE.md §20 (2026-06-24): pull with-ids variant for citation
    # grounding + self-criticism layers.
    sample_posts_with_ids = _sample_posts_with_ids(db, game_id, window_start, window_end)
    sample_posts = {k: [p["text"] for p in v] for k, v in sample_posts_with_ids.items()}
    distinctive = _distinctive_entities(sample_posts)

    # CLAUDE.md §21b: compute per-topic critical-mass tiers so the LLM can
    # only recommend action on themes that survived multiple-day or
    # high-weight evidence — not on single-poster topics that surfaced
    # for display purposes only.
    cm_table = _topic_critical_mass_table(db, game_id, window_start, window_end)

    # CLAUDE.md §24: weekly editorial cache.  Separate from monthly (§24
    # uses scope='weekly' here vs 'monthly' in generate_monthly_summary,
    # giving distinct caches per the user decision).
    editorial_articles = _safe_fetch_editorial(
        db, game_id=game_id, scope="weekly",
        cycle_start=window_start, cycle_end=window_end,
    )

    exec_summary, rec_actions, bold_ideas, citation_map = _call_claude_for_period(
        game_name=game.name,
        window_label=window_label,
        pos_topics=top_pos,
        neg_topics=top_neg,
        neu_topics=top_neu,
        pos_count=pos,
        neg_count=neg,
        neu_count=neu,
        sample_posts=sample_posts,
        distinctive_entities=distinctive,
        sample_posts_with_ids=sample_posts_with_ids,
        commercial_context=game.commercial_context,
        critical_mass_table=cm_table,
        editorial_articles=editorial_articles,
        demographic_context=game.demographic_context,
    )

    # CLAUDE.md §22: pre-flight QA + max-count safety net.
    failures = _validate_summary_output(
        exec_summary=exec_summary,
        recommended_actions=rec_actions,
        bold_ideas=bold_ideas,
        citation_map=citation_map,
        total_posts=total,
        critical_mass_table=cm_table,
    )
    for f in failures:
        logger.warning("§22 pre-flight QA flagged (game_id=%d days=%d): %s", game_id, days, f)

    rec_actions = _truncate_to_max_recommendations(rec_actions)

    # Upsert: a concurrent request (e.g. React StrictMode double-mount, browser
    # refresh racing the in-flight call, or two clients hitting force=true in
    # parallel) may have already inserted a row for the same
    # (game_id, window_days, ingest_date) tuple between our cache MISS check
    # above and this INSERT.  Look up one more time inside the critical section
    # and UPDATE in place if found, INSERT only if truly absent.  This makes
    # the function safe under concurrent calls without needing row-level locks.
    existing: Optional[WindowSummary] = (
        db.query(WindowSummary)
        .filter_by(game_id=game_id, window_days=days, ingest_date=ingest_date)
        .first()
    )
    if existing is not None:
        existing.positive_count       = pos
        existing.negative_count       = neg
        existing.neutral_count        = neu
        existing.total_posts          = total
        existing.top_positive_topics  = top_pos
        existing.top_negative_topics  = top_neg
        existing.top_neutral_topics   = top_neu
        existing.executive_summary    = exec_summary
        existing.recommended_actions  = rec_actions
        existing.bold_ideas           = bold_ideas
        existing.citation_map         = citation_map or None
        existing.generated_at         = datetime.utcnow()
        db.commit()
        db.refresh(existing)
        logger.info(
            "Window summary UPSERT (concurrent insert detected): game=%d days=%d ingest_date=%s total=%d",
            game_id, days, ingest_date, total
        )
        return existing

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
        citation_map=citation_map or None,
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # Lost the race — another request inserted between our pre-INSERT
        # check and our commit.  Roll back, fetch the winner, return it.
        db.rollback()
        winner: Optional[WindowSummary] = (
            db.query(WindowSummary)
            .filter_by(game_id=game_id, window_days=days, ingest_date=ingest_date)
            .first()
        )
        if winner is None:
            # Shouldn't happen — IntegrityError without a winning row means
            # a different constraint failed.  Re-raise so the caller sees it.
            raise
        logger.info(
            "Window summary INSERT lost race; returning winner: game=%d days=%d ingest_date=%s",
            game_id, days, ingest_date,
        )
        return winner
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

    # Top topics per sentiment.  Architecturally we have two sources:
    #   1. SentimentRecord.topics — per-post JSON list, populated by the
    #      nightly _step6_extract_topics gate which only runs on data with
    #      >=2-day span.  Recent posts therefore have topics=[] until the
    #      next nightly run, which leaves window summaries with no topic
    #      signal whenever they cover today's posts.
    #   2. DailySummary.top_{pos,neg,neu}_topics — already aggregated per
    #      day from the same data source AND populated every day, so a
    #      brand-new day has topics ready by the time the per-day rollup
    #      finishes.
    #
    # We aggregate from DailySummary rows in the window.  Each day's top-5
    # contributes 5/4/3/2/1 weighted vote count so a topic that ranks #1 on
    # three days outranks one that ranks #5 on five days.  We then take the
    # top-5 by weighted vote count.  Falls back to the SentimentRecord path
    # when DailySummary has no rows in the window (cold-start case).
    daily_rows = (
        db.query(DailySummary)
        .filter(
            DailySummary.game_id == game_id,
            DailySummary.summary_date >= window_start,
            DailySummary.summary_date <= window_end,
        )
        .all()
    )

    def _weighted_top(attr: str) -> list[str]:
        freq: dict[str, float] = {}
        for row in daily_rows:
            topics = getattr(row, attr, None) or []
            for rank, topic in enumerate(topics[:5]):
                # Rank weight: 5,4,3,2,1 — #1 gets 5 votes, #5 gets 1.
                freq[topic] = freq.get(topic, 0.0) + (5 - rank)
        # Surface up to 8 topics (was 5) so the LLM has more signal handles
        # to anchor recommendations + bold ideas on.  Critical-mass for
        # *recommendations* is enforced separately by
        # _topic_critical_mass_table() at generation time.
        return [t for t, _ in sorted(freq.items(), key=lambda x: -x[1])[:8]]

    top_pos = _weighted_top("top_positive_topics")
    top_neg = _weighted_top("top_negative_topics")
    top_neu = _weighted_top("top_neutral_topics")

    # Fallback: if no DailySummary rows in the window (cold-start) fall back
    # to the per-record SentimentRecord.topics path.
    if not daily_rows or (not top_pos and not top_neg and not top_neu):
        def _record_top_topics(sentiment: SentimentEnum) -> list[str]:
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
            return [t for t, _ in sorted(freq.items(), key=lambda x: -x[1])[:8]]

        if not top_pos: top_pos = _record_top_topics(SentimentEnum.positive)
        if not top_neg: top_neg = _record_top_topics(SentimentEnum.negative)
        if not top_neu: top_neu = _record_top_topics(SentimentEnum.neutral)

    return pos, neg, neu, top_pos, top_neg, top_neu


# §15 conflict-resolution: relaxed critical-mass gate for 1-day windows.
# The nightly _step6_extract_topics enforces ≥3 posts AND ≥3 authors AND
# ≥2 distinct days. A 1-day window can never satisfy the day-span requirement,
# so we drop it here. The post and author thresholds are kept to preserve the
# spirit of §15 (no topic surfaces from a single voice or a single post).
_1DAY_MIN_POSTS   = 3   # same as §15 post threshold
_1DAY_MIN_AUTHORS = 3   # same as §15 author threshold

# Recommendation-class critical mass (CLAUDE.md §21b, 2026-06-29).
# A topic can pass the §15 surface threshold (be visible in the top-N
# negative topics chip list) without being a real theme worthy of a
# strategic recommendation.  Single-poster topics surface for visibility
# but must NOT trigger a recommendation — that's how a lone Turkish post
# became a 'Patch regional localization' recommendation in production.
#
# A topic is RECOMMENDATION-WORTHY only when both:
#   - weighted vote sum ≥ _TOPIC_REC_MIN_WEIGHT (default 5 = appeared as
#     #1 on one day, or #2-#5 on multiple days), AND
#   - it appeared on ≥ _TOPIC_REC_MIN_DAYS distinct DailySummary rows in
#     the window (default 2), OR weight ≥ _TOPIC_REC_SINGLE_DAY_WEIGHT
#     (default 8 = repeated #1-#2 ranking on a single day, indicating a
#     real spike).
#
# Thresholds are deliberately conservative.  Better to under-recommend on
# a thin signal than to push the team toward action on a single voice.
_TOPIC_REC_MIN_WEIGHT       = 5
_TOPIC_REC_MIN_DAYS         = 2
_TOPIC_REC_SINGLE_DAY_WEIGHT = 8


def _topic_critical_mass_table(
    db: Session, game_id: int, window_start, window_end,
) -> dict[str, list[tuple[str, float, int, str]]]:
    """Return per-sentiment lists of (label, weight, day_appearances, tier).

    `tier` is one of:
      'theme'         — cleared the recommendation threshold; OK to recommend.
      'monitor-only'  — visible signal but too thin for a recommendation.

    Used by the actions + bold-ideas prompts: only 'theme' tier topics may
    drive a LIABILITY recommendation.  Topics marked 'monitor-only' get
    listed for context but the prompt forbids recommending action on them.
    """
    out: dict[str, list[tuple[str, float, int, str]]] = {
        "positive": [], "negative": [], "neutral": [],
    }
    daily_rows = (
        db.query(DailySummary)
        .filter(
            DailySummary.game_id == game_id,
            DailySummary.summary_date >= window_start,
            DailySummary.summary_date <= window_end,
        )
        .all()
    )
    for sentiment, attr in [
        ("positive", "top_positive_topics"),
        ("negative", "top_negative_topics"),
        ("neutral",  "top_neutral_topics"),
    ]:
        freq: dict[str, float] = {}
        days: dict[str, int]   = {}
        for row in daily_rows:
            topics = getattr(row, attr, None) or []
            for rank, topic in enumerate(topics[:5]):
                freq[topic] = freq.get(topic, 0.0) + (5 - rank)
                days[topic] = days.get(topic, 0) + 1
        items = [(t, freq[t], days[t]) for t in freq]
        items.sort(key=lambda x: -x[1])
        tiered: list[tuple[str, float, int, str]] = []
        for label, weight, day_count in items[:8]:
            theme = (
                weight >= _TOPIC_REC_MIN_WEIGHT and day_count >= _TOPIC_REC_MIN_DAYS
            ) or weight >= _TOPIC_REC_SINGLE_DAY_WEIGHT
            # §21h (2026-06-29): force-demote NEGATIVE / NEUTRAL narrow-
            # audience topics even if they cross the weight/day threshold.
            # A single-locale negative concern ("Turkish Language Support"
            # as a negative-bucket complaint, "Regional Content Issues") is
            # not a broad-base liability; it's a single audience-of-interest
            # cluster.  Treating it as a theme led to two live execs leading
            # with "Regional Content Issues..." as the headline.
            #
            # POSITIVE narrow-audience topics are NOT demoted: a studio's
            # deliberate localization play ("Welsh Voice Acting", "Brazilian
            # Portuguese support") generating community celebration IS a
            # real marketing asset and a legitimate theme to amplify.
            if (
                theme
                and sentiment in ("negative", "neutral")
                and _topic_is_narrow_audience(label)
            ):
                logger.info(
                    "§21h: demoting narrow-audience %s topic %r from theme to monitor-only "
                    "(weight=%d days=%d)", sentiment, label, weight, day_count,
                )
                tier = "monitor-only"
            else:
                tier = "theme" if theme else "monitor-only"
            tiered.append((label, weight, day_count, tier))
        out[sentiment] = tiered
    return out


# §21h (2026-06-29): narrow-audience topic markers — labels that name a
# specific locale, language, country, platform, storefront, or regional
# content scope.  These are not BROAD-BASE community themes even when they
# cross the weight/day threshold; they reflect a single audience-of-
# interest cluster.  When a topic label matches any of these markers, the
# topic is force-demoted to monitor-only.
#
# The list is intentionally specific.  Adding a marker requires evidence
# that this scope is consistently narrow-audience (i.e. not a broad genre/
# mechanic discussion).  Generic gaming nouns (e.g. "co-op", "campaign",
# "matchmaking") MUST NOT be added here.
_NARROW_AUDIENCE_MARKERS = (
    # Languages / locales
    r"\bturkish\b", r"\bspanish\b", r"\bfrench\b", r"\bgerman\b",
    r"\bitalian\b", r"\bportuguese\b", r"\bbrazilian\b", r"\brussian\b",
    r"\bchinese\b", r"\bjapanese\b", r"\bkorean\b", r"\barabic\b",
    r"\bpolish\b", r"\bcze[ck]h\b", r"\bdutch\b", r"\bswedish\b",
    r"\bnorwegian\b", r"\bdanish\b", r"\bfinnish\b", r"\bgreek\b",
    r"\bhebrew\b", r"\bukrainian\b", r"\bvietnamese\b", r"\bthai\b",
    r"\bindonesian\b", r"\bmalay\b", r"\bfilipino\b", r"\btagalog\b",
    r"\bhindi\b", r"\bbengali\b", r"\bpersian\b", r"\bfarsi\b",
    r"\bromanian\b", r"\bhungarian\b", r"\bbulgarian\b", r"\bserbian\b",
    r"\bcroatian\b", r"\bcatalan\b", r"\bwelsh\b",
    # Countries / regions in scope-narrowing context
    r"\bin\s+turkey\b", r"\bin\s+brazil\b", r"\bin\s+spain\b",
    r"\bin\s+china\b", r"\bin\s+japan\b", r"\bin\s+russia\b",
    r"\bin\s+korea\b", r"\bin\s+india\b",
    # Generic regional / localization labels
    r"\bregional\b", r"\blocaliz(?:e|ed|ation|ing)\b",
    r"\blanguage\s+support\b", r"\blanguage\s+request\b",
    # Single-platform pre-order / SKU questions
    r"\bcollector'?s\s+edition\b", r"\bsteelbook\b", r"\bpre-?order\s+code\b",
    r"\bplatform-specific\b", r"\bphysical\s+edition\b",
)
_NARROW_AUDIENCE_RE = re.compile(
    "|".join(_NARROW_AUDIENCE_MARKERS), re.IGNORECASE,
)


def _topic_is_narrow_audience(label: str) -> bool:
    """True if `label` names a single locale / platform / SKU / regional
    scope rather than a broad-base community theme.  §21h.
    """
    if not label:
        return False
    return bool(_NARROW_AUDIENCE_RE.search(label))


def _format_critical_mass_block(
    table: dict[str, list[tuple[str, float, int, str]]],
) -> str:
    """Render the table for the LLM prompt.  Empty if no rows.

    §21b/§21f scope (2026-06-29): the critical-mass gate applies to
    LIABILITY recommendations only.  POSITIVE amplification recommendations
    anchored on real cited entities are always allowed, even when no
    negative topic reaches theme tier.  The wording below is explicit so
    the LLM does not over-apply the gate and refuse to recommend
    amplifications.
    """
    if not any(table.values()):
        return ""
    lines: list[str] = [
        "TOPIC CRITICAL-MASS TABLE (for LIABILITY recommendation eligibility):",
        "  Each topic listed with [weight, days_observed, tier].",
        "  Only 'theme' tier topics may drive a LIABILITY recommendation ",
        "  (i.e. a recommendation to fix/address/patch a community concern).",
        "  'monitor-only' topics are visible signal but too thin — do NOT",
        "  drive a LIABILITY recommendation on them.",
        "  POSITIVE amplification recommendations (Lean into, Amplify, Double down on, ",
        "  Spotlight, Embrace) anchored on real cited entities are ALWAYS allowed ",
        "  regardless of this table.  The gate is for liabilities, not opportunities.",
    ]
    for sentiment in ("positive", "negative", "neutral"):
        rows = table.get(sentiment) or []
        if not rows:
            continue
        lines.append(f"  {sentiment.upper()}:")
        for label, weight, day_count, tier in rows:
            lines.append(
                f"    - {label!r}  [weight={int(weight)}, days={day_count}, tier={tier}]"
            )
    lines.append("")
    return "\n".join(lines)
_1DAY_TOP_TOPICS  = 8   # max topics per sentiment bucket (raised from 5 → 8 to match window aggregation)


def _aggregate_posts_1day(
    db: Session,
    game_id: int,
    day: date,
) -> tuple[int, int, int, list[str], list[str], list[str]]:
    """
    Aggregate sentiment counts and derive topics for a single-day window.

    MOTIVATION (§15 conflict-resolution):
    The nightly ingestor's _step6_extract_topics stores topic labels per post
    only when ≥3 posts AND ≥3 authors AND ≥2 distinct days are present in the
    candidate corpus. A 1-day window can never satisfy the day-span gate, so
    SentimentRecord.topics is always empty for same-day posts. Calling
    _aggregate_posts on a 1-day window therefore always yields top_*=[].

    This helper bypasses the cached topics and calls
    topic_service.extract_topics_with_metadata directly, applying only the
    relaxed gate: ≥3 distinct posts AND ≥3 distinct authors (no day-span
    requirement, because a 1-day window obviously can’t satisfy it). Per-
    sentiment clusters that pass the gate are returned as topic labels (up to
    _1DAY_TOP_TOPICS per sentiment, ordered by post_count descending).

    See CLAUDE.md §15 for the full critical-mass gate specification.

    Returns (pos, neg, neu, top_positive, top_negative, top_neutral).
    """
    from services import topic_service  # noqa: PLC0415  (local to avoid circular)

    start_dt = datetime.combine(day, datetime.min.time())
    end_dt   = datetime.combine(day, datetime.max.time())

    effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)

    # Collect sentiment + text + author per post for this single day
    rows = (
        db.query(
            SentimentRecord.sentiment,
            RawPost.title,
            RawPost.body,
            RawPost.author,
        )
        .join(RawPost, SentimentRecord.raw_post_id == RawPost.id)
        .filter(
            RawPost.game_id == game_id,
            effective_date >= start_dt,
            effective_date <= end_dt,
        )
        .all()
    )

    # Group posts by sentiment bucket
    buckets: dict[str, list[tuple[str, str]]] = {
        "positive": [],
        "negative": [],
        "neutral": [],
    }
    for sentiment, title, body, author in rows:
        text = (title or "") + ("\n" + body if body else "")
        buckets[sentiment.value].append((text, author or "unknown"))

    pos = len(buckets["positive"])
    neg = len(buckets["negative"])
    neu = len(buckets["neutral"])

    # For each sentiment bucket run topic extraction with relaxed §15 gate
    def _topics_for_bucket(posts: list[tuple[str, str]]) -> list[str]:
        if not posts:
            return []
        texts      = [t for t, _ in posts]
        author_ids = [a for _, a in posts]
        # day_ids all the same single day string (day-span gate not applied here)
        day_str    = str(day)
        day_ids    = [day_str] * len(posts)
        try:
            clusters = topic_service.extract_topics_with_metadata(
                texts, author_ids, day_ids
            )
        except Exception as exc:
            logger.warning(
                "_aggregate_posts_1day: topic extraction failed for day=%s: %s",
                day, exc
            )
            return []

        # Apply relaxed critical-mass: ≥3 posts AND ≥3 distinct authors
        # (day-span requirement dropped — see CLAUDE.md §15 conflict-resolution)
        passing = [
            c for c in clusters
            if c["post_count"] >= _1DAY_MIN_POSTS
            and len(c["author_ids"]) >= _1DAY_MIN_AUTHORS
        ]
        # Sort by post_count descending, return top N labels
        passing.sort(key=lambda c: -c["post_count"])
        return [c["label"] for c in passing[:_1DAY_TOP_TOPICS]]

    top_pos = _topics_for_bucket(buckets["positive"])
    top_neg = _topics_for_bucket(buckets["negative"])
    top_neu = _topics_for_bucket(buckets["neutral"])

    # ── Humanize raw n-gram labels (parity with nightly Step 6) ─────────────
    # Without this the 1-day window returns labels like "fun + posted + originally"
    # which look like database leakage and don't give Claude anything to anchor on.
    # See CLAUDE.md §19: this is part of the executive-summary hardening.
    game = db.query(Game).filter_by(id=game_id).first()
    if game and (top_pos or top_neg or top_neu):
        try:
            from services.topic_service import humanize_topic_labels  # noqa: PLC0415
            humanized = humanize_topic_labels(
                game.name,
                {"positive": top_pos, "negative": top_neg, "neutral": top_neu},
            )
            top_pos = humanized.get("positive", top_pos)
            top_neg = humanized.get("negative", top_neg)
            top_neu = humanized.get("neutral", top_neu)
        except Exception as exc:
            logger.warning(
                "_aggregate_posts_1day: humanization failed for game=%d: %s — keeping raw labels.",
                game_id, exc,
            )

    return pos, neg, neu, top_pos, top_neg, top_neu


# ─────────────────────────────────────────────────────────────────────────────
# Specifics-extraction helpers (the core of the executive-summary hardening).
#
# The pre-2026-05-30 pipeline only passed cluster LABELS (e.g. "Combat
# Mechanics") to Claude.  Those labels are pre-humanized into generic buckets
# by design (CLAUDE.md §13 forbids inventing concepts), so the resulting
# executive summary never named real events: a free DLC release, a specific
# boss fight, a weapon balance change.
#
# These helpers add two new inputs to the Claude prompt:
#   - sample_posts        : up to 12 representative posts per window
#   - distinctive_entities: proper-noun-ish tokens that appear unusually often
#                            in this window (TF against a small baseline)
#
# Together they give Claude raw, specific material to anchor 2+ sentences on,
# while the existing topic labels still carry sentiment-bucketed structure.
# ─────────────────────────────────────────────────────────────────────────────

# Maximum sample posts to surface to Claude.  Keep small so prompt cost stays low.
# Bumped 2026-06-24 from 4 → 8 per bucket (24 posts max instead of 12) so the
# model has wider signal to anchor recommendations + bold ideas on.  Cost is
# ~150-200 tokens of additional prompt input — negligible against Claude
# Haiku input pricing (~$0.10/MTok input) and the output-quality win.
_SAMPLE_POSTS_PER_BUCKET = 8   # × 3 sentiment buckets = 24 posts max
_SAMPLE_POST_TEXT_CHARS  = 280 # truncate each post to ~tweet-length

# Maximum distinctive entities to surface. ~20 is enough headroom for Claude
# to find 3-5 specific anchors per summary.
_MAX_DISTINCTIVE_ENTITIES = 20

# Minimum mention count for an entity to qualify as "distinctive". Below this
# we treat it as noise.
_MIN_ENTITY_MENTIONS = 3


def _sample_posts_for_window(
    db: Session,
    game_id: int,
    window_start: date,
    window_end: date,
    per_bucket: int = _SAMPLE_POSTS_PER_BUCKET,
) -> dict[str, list[str]]:
    """Return up to per_bucket representative posts per sentiment bucket.

    Selection ranks by upvotes DESC then post_date DESC so the most
    engagement-heavy posts surface first.  Each post text is the post title +
    body trimmed to _SAMPLE_POST_TEXT_CHARS so the prompt stays compact.

    Returns {"positive": [...], "negative": [...], "neutral": [...]}.
    """
    start_dt = datetime.combine(window_start, datetime.min.time())
    end_dt   = datetime.combine(window_end,   datetime.max.time())
    effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)

    out: dict[str, list[str]] = {"positive": [], "negative": [], "neutral": []}
    for sentiment in (SentimentEnum.positive, SentimentEnum.negative, SentimentEnum.neutral):
        rows = (
            db.query(RawPost.title, RawPost.body, RawPost.upvotes, RawPost.url)
            .join(SentimentRecord, RawPost.id == SentimentRecord.raw_post_id)
            .filter(
                RawPost.game_id == game_id,
                SentimentRecord.sentiment == sentiment,
                effective_date >= start_dt,
                effective_date <= end_dt,
            )
            .order_by(RawPost.upvotes.desc().nullslast(), effective_date.desc())
            .limit(per_bucket * 3)  # over-fetch so we can dedup near-identical
            .all()
        )
        seen_prefixes: set[str] = set()
        bucket: list[str] = []
        for title, body, upvotes, _url in rows:
            text = (title or "").strip()
            if body and body.strip():
                if text:
                    text = f"{text} — {body.strip()}"
                else:
                    text = body.strip()
            text = text[:_SAMPLE_POST_TEXT_CHARS].strip()
            if len(text) < 30:
                continue
            # Dedup by first-60-char prefix to filter near-identical reposts
            prefix = text[:60].lower()
            if prefix in seen_prefixes:
                continue
            seen_prefixes.add(prefix)
            bucket.append(text)
            if len(bucket) >= per_bucket:
                break
        out[sentiment.value] = bucket
    return out


# Stop words & common gaming verbs we never want to surface as "distinctive entities"
_ENTITY_STOPWORDS = frozenset({
    "the", "and", "for", "with", "that", "this", "have", "has", "from", "but",
    "you", "they", "are", "was", "were", "been", "being", "than", "then",
    "what", "when", "where", "who", "why", "how", "all", "any", "can", "could",
    "would", "should", "may", "might", "must", "will", "shall", "did", "does",
    "into", "onto", "out", "off", "over", "under", "more", "less", "most",
    "least", "very", "really", "actually", "just", "only", "even", "also",
    "still", "ever", "never", "always", "some", "many", "much", "few", "lot",
    "lots", "thing", "things", "stuff", "way", "ways", "time", "times", "day",
    "days", "week", "weeks", "month", "months", "year", "years",
    "game", "games", "play", "player", "players", "playing", "played", "play",
    "post", "posts", "comment", "comments", "reddit", "subreddit", "steam",
    "good", "bad", "great", "awesome", "fun", "boring", "love", "hate",
    "like", "want", "need", "feel", "think", "know", "say", "said", "see",
    "look", "go", "going", "come", "get", "got", "make", "made", "take",
    "use", "used", "give", "find", "found",
    "yes", "no", "yeah", "yep", "nope",
    "https", "http", "com", "www", "imgur", "youtube", "youtu",
})


def _distinctive_entities(
    sample_posts_by_sentiment: dict[str, list[str]],
    max_entities: int = _MAX_DISTINCTIVE_ENTITIES,
) -> list[str]:
    """Surface tokens that look like specific entities — capitalized words,
    multi-word capitalized phrases, version numbers, hashtags, and unusually
    distinctive lowercase tokens.

    Args:
        sample_posts_by_sentiment: output of _sample_posts_for_window().
        max_entities: cap on returned distinct entity strings.

    Returns ordered list of entity strings, most-mentioned first.

    Design notes:
      - Capitalized multi-word phrases (e.g. "Tyranid Warrior", "Salamanders
        Champion Pack") are highest signal.  We capture sequences of
        Capitalized tokens.
      - Version numbers (e.g. "v1.7", "1.7.2", "patch 1.7") are next highest.
      - Single capitalized tokens NOT at sentence start are also useful.
      - Lowercase tokens that appear in ≥3 distinct posts and aren't in
        _ENTITY_STOPWORDS are surfaced as a fallback.
    """
    all_text = "\n".join(
        p for posts in sample_posts_by_sentiment.values() for p in posts
    )
    if not all_text.strip():
        return []

    # ── 1. Capitalized phrases (1-4 words) ──────────────────────────────────
    # Match runs of Capitalized tokens, optionally with "of"/"the"/"&" between.
    cap_phrase_re = re.compile(
        r"\b([A-Z][a-zA-Z0-9]+(?:\s+(?:of\s+|the\s+|&\s+|and\s+)?[A-Z][a-zA-Z0-9]+){0,3})\b"
    )
    # ── 2. Version-number-ish patterns ──────────────────────────────────────
    version_re = re.compile(r"\b(?:v|patch|update|build)?\s*(\d+\.\d+(?:\.\d+)?)\b", re.IGNORECASE)
    # ── 3. Hashtags / @-mentions (often event handles) ───────────────────────
    tag_re = re.compile(r"[#@]\w{3,}")

    counts: dict[str, int] = {}
    posts_containing: dict[str, set[int]] = {}

    post_idx = 0
    for posts in sample_posts_by_sentiment.values():
        for text in posts:
            this_post_entities: set[str] = set()
            for m in cap_phrase_re.finditer(text):
                phrase = m.group(1).strip()
                # Drop single-word stopwords (e.g. "The") and game-name-only
                if len(phrase) < 3:
                    continue
                lower = phrase.lower()
                if lower in _ENTITY_STOPWORDS:
                    continue
                this_post_entities.add(phrase)
            for m in version_re.finditer(text):
                this_post_entities.add(m.group(0).strip())
            for m in tag_re.finditer(text):
                this_post_entities.add(m.group(0))
            for ent in this_post_entities:
                counts[ent] = counts.get(ent, 0) + 1
                posts_containing.setdefault(ent, set()).add(post_idx)
            post_idx += 1

    # Keep only entities mentioned in >=_MIN_ENTITY_MENTIONS distinct posts
    qualifying = [
        (ent, len(posts_containing[ent]))
        for ent in counts
        if len(posts_containing[ent]) >= _MIN_ENTITY_MENTIONS
    ]
    # Sort by post-mention count descending; tie-break by total mentions
    qualifying.sort(key=lambda x: (-x[1], -counts[x[0]]))

    # Lower the threshold to >=2 if we don't have enough entities yet
    if len(qualifying) < 5:
        relaxed = [
            (ent, len(posts_containing[ent]))
            for ent in counts
            if len(posts_containing[ent]) >= 2
        ]
        relaxed.sort(key=lambda x: (-x[1], -counts[x[0]]))
        # Merge, preserving dedup and order
        seen = {e for e, _ in qualifying}
        for ent, c in relaxed:
            if ent not in seen and len(qualifying) < max_entities:
                qualifying.append((ent, c))
                seen.add(ent)

    return [ent for ent, _ in qualifying[:max_entities]]


# ─────────────────────────────────────────────────────────────────────────────

# Minimum number of substantive posts required before attempting a confident
# AI summary.  Below this threshold the pipeline returns the insufficient-signal
# sentinel without calling Claude (§15).
_MIN_SUBSTANTIVE_POSTS = 20

# CLAUDE.md §22 (Pre-flight QA, 2026-06-29) recommendation count targets.
# Both apply only when total_posts ≥ _MIN_SUBSTANTIVE_POSTS AND there is at
# least one theme-tier topic available; otherwise fewer is fine.
_REC_COUNT_MIN = 3

# 2026-06-29 diagnostic ring buffer for bold-ideas trace.  Last N entries are
# kept in memory; the diagnostic API endpoint reads from here.  Each entry is
# a dict with keys: game_name, raw_preview, after_parse, after_strip_uncited,
# after_self_criticize, after_sanitize, after_strip_orphan, final.
from collections import deque
_BOLD_TRACE_BUFFER: deque = deque(maxlen=20)
_EXEC_TRACE_BUFFER: deque = deque(maxlen=20)
_RECS_TRACE_BUFFER: deque = deque(maxlen=20)


def _record_bold_trace(entry: dict) -> None:
    _BOLD_TRACE_BUFFER.append(entry)


def _record_exec_trace(entry: dict) -> None:
    _EXEC_TRACE_BUFFER.append(entry)


def _record_recs_trace(entry: dict) -> None:
    _RECS_TRACE_BUFFER.append(entry)


def get_bold_trace_buffer() -> list[dict]:
    """Returns a snapshot of the bold-ideas trace ring buffer."""
    return list(_BOLD_TRACE_BUFFER)


def get_exec_trace_buffer() -> list[dict]:
    """§24e: returns a snapshot of the executive-summary trace ring buffer."""
    return list(_EXEC_TRACE_BUFFER)


def get_recs_trace_buffer() -> list[dict]:
    """§24e: returns a snapshot of the recommended-actions trace ring buffer."""
    return list(_RECS_TRACE_BUFFER)
_REC_COUNT_MAX = 5

# Imperative verbs that a recommendation MUST start with after the
# numbered prefix.  Items starting with non-imperative phrasing like
# "Note that...", "It appears...", "The community...", "This shows..."
# are observations not recommendations — drop them.
#
# 2026-06-29 expansion: the previous narrow list was dropping perfectly
# good PM imperatives the LLM actually uses (Optimize, Tune, Surface,
# Improve, Investigate, etc.).  This list captures the common imperative-
# verb vocabulary for product/community management: action verbs,
# investigation verbs, communication verbs, optimization verbs, content
# verbs, monetization verbs.  When in doubt, ADD a verb here — it's far
# worse to drop a good recommendation than to admit a borderline one.
_RECOMMENDATION_VERB_RE = re.compile(
    r"^\s*\d+\.\s*\*?\*?"
    r"(?:"
    # Amplify-class (§21 positive comparisons)
    r"lean\s+into|amplify|double\s+down|anchor\s+on|spotlight|embrace|"
    r"capitalize|leverage|harness|elevate|champion|highlight|emphasize|"
    # Fix-class (§21 liabilities, live-game)
    r"ship|patch|hotfix|rebalance|nerf|buff|fix|repair|resolve|"
    r"address|reframe|tune|optimize|improve|stabilize|polish|refine|"
    # Communicate-class
    r"clarify|communicate|document|publish|reveal|showcase|reassure|"
    r"announce|share|update|explain|confirm|acknowledge|respond|"
    # Investigation-class
    r"audit|investigate|review|analyze|measure|benchmark|track|monitor|"
    r"surface|expose|probe|examine|profile|diagnose|"
    # Strategy-class
    r"prioritize|invest|expand|sunset|launch|deploy|release|roll\s*out|"
    r"pivot|reposition|counter-position|test|experiment|pilot|"
    # Content / engagement
    r"feature|promote|distribute|seed|host|run|organize|coordinate|"
    r"partner|collaborate|engage|cultivate|grow|recruit|"
    # Monetization / business
    r"price|bundle|tier|gate|monetize|upsell|cross-sell|reduce|extend|"
    # Safety / hygiene
    r"escalate|mitigate|deprecate|remove|disable|enforce|protect|harden"
    r")",
    re.IGNORECASE,
)


def _validate_summary_output(
    *,
    exec_summary: Optional[str],
    recommended_actions: Optional[str],
    bold_ideas: list[str],
    citation_map: dict,
    total_posts: int,
    critical_mass_table: Optional[dict[str, list[tuple[str, float, int, str]]]] = None,
) -> list[str]:
    """Pre-flight QA on summary output (CLAUDE.md §22).  Returns a list of
    human-readable failure descriptions; empty list means clean.  Designed
    to be called AFTER the layer-3/4 strippers but BEFORE persistence.

    Failures returned (not raised) so the caller can decide: attempt one
    regen with the failures injected as a correction list, or drop the
    offending field and ship the rest.
    """
    failures: list[str] = []

    # EXEC checks
    if exec_summary:
        if _DANGLING_DISCOURSE_RE.match(exec_summary):
            failures.append(
                "exec_summary opens with an orphan discourse marker "
                f"({exec_summary[:40]!r}) — no preceding sentence to refer to"
            )
        if citation_map and not _extract_citations(exec_summary):
            failures.append(
                "exec_summary has zero surviving citations despite citation_map being non-empty"
            )
    elif total_posts >= _MIN_SUBSTANTIVE_POSTS:
        # Empty exec above the §15 threshold is suspicious but not always
        # wrong (the LLM may have correctly returned an insufficient-claims
        # message that was then stripped).  Surface as a soft warning.
        failures.append(
            f"exec_summary is empty but total_posts={total_posts} is above the §15 substantive threshold"
        )

    # ACTIONS checks
    if recommended_actions:
        items = [
            line.strip()
            for line in recommended_actions.split("\n")
            if line.strip() and re.match(r"^\d+\.\s", line.strip())
        ]
        # Check 4: no empty-stub items.
        for it in items:
            if not _item_has_substantive_content(it):
                failures.append(
                    f"recommendation is an empty stub (citation-only): {it[:60]!r}"
                )
        # Check 5: minimum count when data warrants.
        themes_available = bool(
            critical_mass_table and any(
                t for t, _, _, tier in (critical_mass_table.get("negative") or [])
                + (critical_mass_table.get("positive") or [])
                if tier == "theme"
            )
        ) if critical_mass_table else True
        if (
            total_posts >= _MIN_SUBSTANTIVE_POSTS
            and themes_available
            and len(items) < _REC_COUNT_MIN
        ):
            failures.append(
                f"only {len(items)} recommendations — target minimum is {_REC_COUNT_MIN} "
                f"and {sum(1 for t in (critical_mass_table or {}).get('negative', []) + (critical_mass_table or {}).get('positive', []) if t[3] == 'theme')} "
                "theme-tier topics were available"
            )
        # Check 6: maximum count.
        if len(items) > _REC_COUNT_MAX:
            failures.append(
                f"{len(items)} recommendations exceeds maximum {_REC_COUNT_MAX}; "
                "truncate at persist time"
            )
        # Check 7: every item starts with an imperative verb.
        for it in items:
            if _item_has_substantive_content(it) and not _RECOMMENDATION_VERB_RE.match(it):
                failures.append(
                    f"recommendation does not start with an imperative verb: {it[:80]!r}"
                )
        # Check 8: every item has a bolded entity.
        for it in items:
            if _item_has_substantive_content(it) and "**" not in it:
                failures.append(
                    f"recommendation missing bolded entity (**...**): {it[:80]!r}"
                )

    # BOLD IDEAS checks
    for idea in (bold_ideas or []):
        if not idea or not idea.strip():
            failures.append("bold idea is empty")
            continue
        # citation token presence
        if citation_map and not _extract_citations(idea):
            failures.append(
                f"bold idea has no citation tokens: {idea[:80]!r}"
            )
        # substantive prose (use same empty-item check)
        # Bold ideas don't have a number prefix; check for prose-length
        # outside of citation tokens.
        stripped = re.sub(r"\[(?:P-\d{1,4}[\s,;]*)+\]", "", idea).strip()
        if len(stripped) < 20:
            failures.append(
                f"bold idea is empty after stripping citations: {idea[:80]!r}"
            )

    return failures


def _enforce_format_contract(text: Optional[str]) -> Optional[str]:
    """Drop recommendations that violate the surface format contract:
      - empty stubs (citation-only after the number prefix),
      - no imperative verb opener,
      - no bolded entity (**...**).

    These are §22 mechanical checks.  Better to ship 2 valid items than
    3 items where one is an off-format paragraph dump that pretends to
    be a recommendation.  Called at persist time after the LLM pipeline.
    """
    if not text:
        return text
    items: list[str] = []
    current: list[str] = []

    def flush():
        nonlocal current
        if current:
            items.append(" ".join(current).strip())
            current = []

    for line in text.split("\n"):
        if re.match(r"^\d+\.\s", line.strip()):
            flush()
            current.append(line.strip())
        elif line.strip():
            current.append(line.strip())
        else:
            flush()
    flush()

    survivors: list[str] = []
    for item in items:
        if not _item_has_substantive_content(item):
            logger.info("§22 format-contract: dropping empty-stub %r", item[:60])
            continue
        if not _RECOMMENDATION_VERB_RE.match(item):
            logger.info("§22 format-contract: dropping non-imperative %r", item[:80])
            continue
        if "**" not in item:
            logger.info("§22 format-contract: dropping missing-bold %r", item[:80])
            continue
        survivors.append(item)

    if not survivors:
        return ""
    # Renumber + cap at max.
    capped = survivors[:_REC_COUNT_MAX]
    out: list[str] = []
    for n, item in enumerate(capped, 1):
        cleaned = re.sub(r"^\d+\.\s*", "", item.strip())
        out.append(f"{n}. {cleaned}")
    return "\n\n".join(out)


# Backward-compatible alias — some callers still use the old name.
def _truncate_to_max_recommendations(text: Optional[str]) -> Optional[str]:
    return _enforce_format_contract(text)


def _call_claude_for_period(
    game_name: str,
    window_label: str,
    pos_topics: list[str],
    neg_topics: list[str],
    neu_topics: list[str],
    pos_count: int,
    neg_count: int,
    neu_count: int,
    sample_posts: Optional[dict[str, list[str]]] = None,
    distinctive_entities: Optional[list[str]] = None,
    # CLAUDE.md §20 layers 3+4: optional citation infrastructure.  When
    # provided, the LLM is required to cite [P-NNN] tokens on every claim,
    # uncited claims are dropped, and a second LLM call validates each
    # cited claim against the actual post text.  Callers that want the
    # protection pass both args; legacy callers can omit them and get the
    # previous behavior (prompt rule + proper-noun fact check only).
    sample_posts_with_ids: Optional[dict[str, list[dict]]] = None,
    # CLAUDE.md §21 (Commercial Strategic Context, 2026-06-29): per-title
    # positioning brief.  Tells the LLM what comparisons are commercial
    # assets, what genre tailwinds to ride, what competitors to differentiate
    # from, and what NOT to advise away from.  None / empty → the prompt
    # falls back to a release-status-aware default.
    commercial_context: Optional[str] = None,
    # CLAUDE.md §21b (Recommendation-class critical mass, 2026-06-29):
    # per-topic table of (label, weight, day_appearances, tier).  Only
    # tier=='theme' topics may drive a LIABILITY recommendation.
    critical_mass_table: Optional[dict[str, list[tuple[str, float, int, str]]]] = None,
    # CLAUDE.md §24 (Editorial-Research Hybrid Bold Ideas, 2026-06-29):
    # pre-fetched editorial articles for this title + cycle, plus the
    # demographic-context brief.  Passed only to the bold-ideas call; the
    # exec and recommendations remain post-only (strict §20) per the
    # hybrid scope decision.  Empty when §24 is not yet wired or no
    # articles were available.
    editorial_articles: Optional[list] = None,
    demographic_context: Optional[str] = None,
) -> tuple[str, Optional[str], list[str], dict[str, dict]]:
    """
    Call Claude for (exec_summary, recommended_actions, bold_ideas).

    Bug 2 fix: accepts pos_count/neg_count/neu_count instead of total_posts so
    the exec-summary prompt can include the actual breakdown. This prevents
    Claude from writing "no clear negative signals" next to a significant
    negative count, which contradicts the KPI numbers shown in the dashboard.

    Returns placeholder strings if the API key is missing or calls fail.
    recommended_actions: Optional[str] — None when Claude returns NONE or all
      content was meta-leak (frontend hides the section).
    bold_ideas: list[str] — empty list when Claude returns "NONE" or all
      candidates were filtered out by quality checks.

    §15 total-volume gate: if total_posts < _MIN_SUBSTANTIVE_POSTS, returns the
    insufficient-signal sentinel immediately without calling Claude.
    This fix only applies when Claude is actually invoked (total >= 20).
    """
    total_posts = pos_count + neg_count + neu_count

    # ── §15: Insufficient-signal sentinel ────────────────────────────────────
    if total_posts < _MIN_SUBSTANTIVE_POSTS:
        logger.info(
            "Insufficient signal for '%s' %s: only %d posts (need %d) — skipping Claude.",
            game_name, window_label, total_posts, _MIN_SUBSTANTIVE_POSTS,
        )
        exec_summary = (
            f"Insufficient signal for confident reporting "
            f"(only {total_posts} substantive posts in this window)."
        )
        return exec_summary, None, [], {}

    client = _get_client()
    if client is None:
        return (
            _placeholder_summary(
                game_name, window_label, total_posts,
                pos_str=", ".join(pos_topics) if pos_topics else "",
                neg_str=", ".join(neg_topics) if neg_topics else "",
                pos_count=pos_count, neg_count=neg_count, neu_count=neu_count,
            ),
            _placeholder_actions(),
            [],
            {},
        )

    # Quarantine poisoned topic labels before they reach the LLM. Any label
    # containing a forbidden-concept token (free-to-play / battle pass /
    # monetization / etc.) is dropped so Claude can't anchor a summary on it.
    # If quarantining empties a sentiment's list, we substitute a generic
    # fallback so the LLM still has something to talk about.
    pos_topics = _quarantine_topics(pos_topics)
    neg_topics = _quarantine_topics(neg_topics)
    neu_topics = _quarantine_topics(neu_topics)

    pos_str = ", ".join(pos_topics) if pos_topics else "General positive sentiment"
    neg_str = ", ".join(neg_topics) if neg_topics else "No clear negative signals"
    neu_str = ", ".join(neu_topics) if neu_topics else "General neutral discussion"

    # Sample posts and distinctive entities give Claude raw, specific material
    # to anchor on (e.g. a DLC release, a boss name, a weapon balance change).
    # Without them the summary collapses to abstract "general sentiment" prose
    # — see CLAUDE.md §19 and the 2026-05-30 hardening pass.
    sample_posts = sample_posts or {"positive": [], "negative": [], "neutral": []}
    distinctive_entities = distinctive_entities or []

    # Build the citation map up front so every prompt + sanitizer uses the
    # same [P-NNN] namespace.  Empty when caller didn't pass the with-ids
    # variant of samples (legacy path).
    annotated_samples: dict[str, list[dict]] = {"positive": [], "negative": [], "neutral": []}
    citation_map: dict[str, dict] = {}
    if sample_posts_with_ids:
        annotated_samples, citation_map = _assign_citation_ids(sample_posts_with_ids)

    exec_summary  = _call_exec(
        client, game_name, window_label, pos_str, neg_str, neu_str,
        total_posts, pos_count, neg_count, neu_count,
        sample_posts=sample_posts,
        distinctive_entities=distinctive_entities,
        annotated_samples=annotated_samples,
        citation_map=citation_map,
        commercial_context=commercial_context,
        critical_mass_table=critical_mass_table,
        editorial_articles=editorial_articles,
    )
    rec_actions   = _call_actions(
        client, game_name, window_label, pos_str, neg_str, neu_str,
        sample_posts=sample_posts,
        distinctive_entities=distinctive_entities,
        annotated_samples=annotated_samples,
        citation_map=citation_map,
        commercial_context=commercial_context,
        critical_mass_table=critical_mass_table,
        editorial_articles=editorial_articles,
    )
    # §22b + §24e: low-rec-count retry on every substantive title (no theme gate).
    rec_actions = _retry_actions_if_below_min(
        client=client,
        rec_actions=rec_actions,
        total_posts=total_posts,
        game_name=game_name,
        window_label=window_label,
        pos_str=pos_str,
        neg_str=neg_str,
        neu_str=neu_str,
        sample_posts=sample_posts,
        distinctive_entities=distinctive_entities,
        annotated_samples=annotated_samples,
        citation_map=citation_map,
        commercial_context=commercial_context,
        critical_mass_table=critical_mass_table,
        editorial_articles=editorial_articles,
    )
    bold_ideas    = _call_bold_ideas(
        client, game_name, window_label, pos_str, neg_str, neu_str, total_posts,
        sample_posts=sample_posts,
        distinctive_entities=distinctive_entities,
        annotated_samples=annotated_samples,
        citation_map=citation_map,
        commercial_context=commercial_context,
        critical_mass_table=critical_mass_table,
        editorial_articles=editorial_articles,
        demographic_context=demographic_context,
    )

    return exec_summary, rec_actions, bold_ideas, citation_map


# ── Topic-label quarantine (CLAUDE.md §13 defense in depth) ─────────────────────
# Even after the humanization filter, older DB rows may still hold poisoned
# topic labels (e.g. "Free to Play Model" attributed to a non-F2P game). We
# drop these on the way into the summary prompts so the LLM never sees them.
_QUARANTINE_TOKENS = (
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
)


def _quarantine_topics(labels: list[str]) -> list[str]:
    """Drop any topic label that contains a forbidden monetization-concept token.

    Returns a new list with poisoned labels removed. Original order preserved.
    See CLAUDE.md §13 — evidence-only insights.
    """
    kept: list[str] = []
    for label in (labels or []):
        if not isinstance(label, str) or not label.strip():
            continue
        normalized = re.sub(r"[^a-z0-9]+", " ", label.lower()).strip()
        if any(tok in normalized for tok in _QUARANTINE_TOKENS):
            logger.info("Quarantined poisoned topic label from summary input: %r", label)
            continue
        kept.append(label)
    return kept


# ── Output style for all summary LLM calls (CLAUDE.md §13) ──────────────────────
# A style guide — NOT a list of "rules" the model can mention.
# Critical: the output must read like an analyst speaking to a reader. The
# constraints below are guidance for the writer; the writer must NEVER refer to
# them, justify what it can't do, or reveal that it was told anything. If an
# insight isn't supported, just don't write it.
_OUTPUT_STYLE = (
    "OUTPUT STYLE (follow silently, never mention these rules in the output):\n"
    "- Write as a confident analyst. Use the topic labels exactly as provided.\n"
    "- Never reference reasoning, instructions, rules, system prompts, or your own limitations. "
    "Never say \"I cannot\", \"the rules say\", \"I'm instructed\", \"insufficient data to provide\", "
    "\"based on the constraints\", or anything that breaks the analyst voice.\n"
    "- Do not invent topics or extrapolate. Only discuss what the topic labels actually say. "
    "If a topic isn't there, don't mention the concept.\n"
    "- If post volume is low, note it briefly and write a shorter, hedged analysis — do NOT apologize or refuse.\n"
    "- Never reference monetization, business model, pricing, platforms, or release strategy unless a topic label literally names them.\n"
    "- If you genuinely have nothing useful to say, follow the empty-output sentinel for the section (specified below). "
    "Do NOT write a meta-explanation about why you're empty.\n\n"
)


# ── Citation grounding + self-criticism (CLAUDE.md §20 layers 3+4) ──────────
#
# Layer 1 (prompt rule) and layer 2 (post-LLM proper-noun fact check) catch
# fabricated named entities but NOT semantic hallucination — claims that use
# only real names but invent the relationship/quantity/direction between them.
#
# Layers 3 and 4 close that gap:
#
#   Layer 3 — Citation Grounding.  Every sample post is assigned a stable
#   token [P-NNN] and the prompts require every sentence/item to end with at
#   least one such citation.  Sentences without a valid citation are dropped
#   post-LLM.  The user-visible email renders citations as superscript links
#   to the actual post URLs so claims are auditable.
#
#   Layer 4 — Self-Criticism Pass.  A second Claude call is given (output
#   text, source posts that were cited) and asked to verdict each sentence
#   as SUPPORTED or UNSUPPORTED against the post it cites.  Unsupported
#   sentences are stripped.  Costs ~1 extra LLM call per LLM-produced output
#   block.

# Matches a bracketed citation segment.  Accepts P-NNN (post citations,
# original §20) and E-NNN (editorial citations, §24 2026-06-29) and
# mixed groups like [P-001, E-003].
_CITATION_BRACKET_RE = re.compile(r"\[((?:[PE]-\d{1,4}[\s,;]*)+)\]")
_CITATION_INNER_RE = re.compile(r"([PE])-(\d{1,4})")


def _sample_posts_with_ids(
    db: Session,
    game_id: int,
    window_start: date,
    window_end: date,
    per_bucket: int = _SAMPLE_POSTS_PER_BUCKET,
) -> dict[str, list[dict]]:
    """Sibling of _sample_posts_for_window() that ALSO returns post id + url.

    Returns {"positive": [{"id": int, "text": str, "url": str | None}, ...],
             "negative": [...], "neutral": [...]}.

    The id is the SentimentPulse internal RawPost.id — stable for the
    lifetime of the row, useful for both prompt-side citations and later
    UI link rendering.
    """
    start_dt = datetime.combine(window_start, datetime.min.time())
    end_dt   = datetime.combine(window_end,   datetime.max.time())
    effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)

    out: dict[str, list[dict]] = {"positive": [], "negative": [], "neutral": []}
    for sentiment in (SentimentEnum.positive, SentimentEnum.negative, SentimentEnum.neutral):
        rows = (
            db.query(RawPost.id, RawPost.title, RawPost.body, RawPost.upvotes, RawPost.url)
            .join(SentimentRecord, RawPost.id == SentimentRecord.raw_post_id)
            .filter(
                RawPost.game_id == game_id,
                SentimentRecord.sentiment == sentiment,
                effective_date >= start_dt,
                effective_date <= end_dt,
            )
            .order_by(RawPost.upvotes.desc().nullslast(), effective_date.desc())
            .limit(per_bucket * 3)
            .all()
        )
        seen_prefixes: set[str] = set()
        bucket: list[dict] = []
        for pid, title, body, _upvotes, url in rows:
            text = (title or "").strip()
            if body and body.strip():
                text = f"{text} — {body.strip()}" if text else body.strip()
            text = text[:_SAMPLE_POST_TEXT_CHARS].strip()
            if len(text) < 30:
                continue
            prefix = text[:60].lower()
            if prefix in seen_prefixes:
                continue
            seen_prefixes.add(prefix)
            bucket.append({"id": int(pid), "text": text, "url": url})
            if len(bucket) >= per_bucket:
                break
        out[sentiment.value] = bucket
    return out


def _assign_citation_ids(
    sample_posts_with_ids: dict[str, list[dict]],
) -> tuple[dict[str, list[dict]], dict[str, dict]]:
    """Assign each sample post a [P-NNN] citation token.

    Returns:
      (annotated_samples, citation_map)
    where annotated_samples is the input shape with an added "cite" key per
    post (e.g. "P-001"), and citation_map maps the cite string -> the post
    dict, used by the post-LLM filter to validate citations and by the
    email renderer to resolve them to URLs.

    Numbering is stable across sentiment buckets: positives first (P-001..),
    then negatives, then neutrals.  This gives the LLM a single contiguous
    citation namespace it can reason about.
    """
    citation_map: dict[str, dict] = {}
    annotated: dict[str, list[dict]] = {"positive": [], "negative": [], "neutral": []}
    counter = 1
    for sentiment in ("positive", "negative", "neutral"):
        for post in sample_posts_with_ids.get(sentiment) or []:
            cite = f"P-{counter:03d}"
            counter += 1
            annotated_post = dict(post)
            annotated_post["cite"] = cite
            annotated_post["sentiment"] = sentiment
            annotated[sentiment].append(annotated_post)
            citation_map[cite] = annotated_post
    return annotated, citation_map


def _format_sample_posts_block_with_citations(
    annotated_samples: dict[str, list[dict]],
) -> str:
    """Same shape as _format_sample_posts_block, but each post is rendered
    with its [P-NNN] token at the start so the LLM can cite it."""
    parts: list[str] = []
    for sentiment in ("positive", "negative", "neutral"):
        posts = annotated_samples.get(sentiment) or []
        if not posts:
            continue
        parts.append(f"-- {sentiment.upper()} samples --")
        for post in posts:
            single_line = " ".join(post["text"].split())
            parts.append(f"  [{post['cite']}] {single_line}")
    return "\n".join(parts)


def _citation_requirement_clause(citation_map: dict[str, dict]) -> str:
    """Mandatory clause: every claim must end with at least one [P-NNN]
    citation, where the cited posts exist in the citation_map."""
    if not citation_map:
        return ""
    valid_cites = ", ".join(sorted(citation_map.keys()))
    return (
        "CITATION REQUIREMENT (HARD):\n"
        "- Every sentence (executive summary) or every numbered item\n"
        "  (recommendations and bold ideas) MUST end with at least one\n"
        "  citation in square brackets referencing a sample post you saw\n"
        "  in the data block below.  Format: [P-001] or [P-001, P-003].\n"
        "- The citation must come from this allowed list ONLY:\n"
        f"  {valid_cites}\n"
        "- If a claim has no supporting sample post, do NOT make the claim.\n"
        "- Output without citations will be dropped.  Cite or omit.\n\n"
    )


def _extract_citations(text: str) -> set[str]:
    """Return all P-NNN and E-NNN tokens found in bracketed citations inside `text`.

    Supports compound forms: [P-001], [P-001, P-002], [P-001; P-003],
    and mixed P/E groups: [P-001, E-003].  §24 2026-06-29 added the
    E-NNN form for editorial citations.

    Does NOT match bare P-001 outside brackets so noise in unrelated
    prose cannot accidentally satisfy the citation requirement.
    """
    out: set[str] = set()
    for bracket_match in _CITATION_BRACKET_RE.finditer(text or ""):
        inside = bracket_match.group(1)
        for m in _CITATION_INNER_RE.finditer(inside):
            kind = m.group(1).upper()
            n = int(m.group(2))
            out.add(f"{kind}-{n:03d}")
    return out


# Discourse markers that only make sense when a preceding sentence has
# already been written.  If the layer-3 sentence strip removes that
# preceding sentence and leaves one of these as the new opener, the result
# reads as a non-sequitur ("However, X happened." — however what?).
# 2026-06-29 fix after Toxic Commando exec opened with "However,".
_DANGLING_DISCOURSE_RE = re.compile(
    r"^\s*(?:however|moreover|additionally|furthermore|also|conversely|"
    r"on\s+the\s+other\s+hand|nevertheless|nonetheless|yet|but|that\s+said|"
    r"meanwhile|in\s+contrast|in\s+addition|then\s+again)[\s,]+",
    re.IGNORECASE,
)

# 2026-06-29 (§21c+§22 hardening): the sentence-split sanitizer can leave a
# mid-sentence fragment as the new lead.  Concrete failure on Space Marine 2:
# the LLM wrote "Across 968 posts (233 positive vs 109 negative), players..."
# and the uncited-sentence stripper chopped the (citationless) first piece,
# exposing "109 negative), players consistently praise..." as the new lead.
# Detect any of:
#  • lead starts with an unmatched closing paren / bracket
#  • lead starts with a digit followed by closing paren ("109)")
#  • lead starts with a lowercase letter (mid-sentence continuation)
#  • lead starts with a conjunction-only piece (", and...", "and they...")
_FRAGMENT_OPENER_RE = re.compile(
    r"^\s*(?:\d+\s*[\)\]]|[\)\]\,]|and\s+|but\s+|or\s+|so\s+|because\s+|"
    r"which\s+|while\s+|though\s+|whereas\s+)",
    re.IGNORECASE,
)


def _looks_like_fragment_lead(text: str) -> bool:
    """True if `text` opens like a mid-sentence fragment rather than a
    clean sentence start.  Catches the SM2 "109 negative), players..."
    failure mode and similar.

    Three signals:
      1. The first alpha char (after optional opening quote) is lowercase
         — mid-sentence continuations almost always start lowercase.
      2. The text matches _FRAGMENT_OPENER_RE — explicit conjunction/
         punctuation starts.
      3. The first sentence contains an unmatched closing paren / bracket
         before any opening one — the SM2 "109 negative), players..."
         failure mode where the matching '(' was sliced off.
    """
    if not text:
        return False
    stripped = text.lstrip()
    if not stripped:
        return False
    # Lowercase first letter (after optional opening quote) almost always
    # indicates a mid-sentence continuation.
    first_char = stripped[0]
    if first_char in ("\"", "'", "“", "‘"):
        first_char = stripped[1] if len(stripped) > 1 else first_char
    if first_char.isalpha() and first_char.islower():
        return True
    if _FRAGMENT_OPENER_RE.match(stripped):
        return True
    # Unmatched closing paren/bracket in the first sentence — the SM2
    # "... vs 109 negative), players..." case after the front was chopped.
    first_sentence = re.split(r"(?<=[.!?])\s+", stripped, maxsplit=1)[0]
    opens = first_sentence.count("(") + first_sentence.count("[")
    closes = first_sentence.count(")") + first_sentence.count("]")
    if closes > opens:
        return True
    return False


def _scrub_orphan_opener(text: str) -> str:
    """If `text` opens with a discourse marker that depends on a preceding
    sentence (However, Moreover, Additionally, etc.), drop the marker so the
    sentence reads as a standalone statement.

    Example: "However, a critical liability has emerged: post-match black
    screens are blocking players..." → "A critical liability has emerged:
    post-match black screens are blocking players..."
    """
    if not text:
        return text
    stripped = _DANGLING_DISCOURSE_RE.sub("", text, count=1)
    if not stripped or stripped == text:
        return text
    # Capitalize the first letter after the strip if the remainder begins
    # mid-sentence.
    return stripped[0].upper() + stripped[1:] if stripped[0].isalpha() else stripped


def _strip_uncited_sentences(text: str, citation_map: dict[str, dict]) -> str:
    """Drop any sentence in `text` that lacks a citation (or cites an
    unknown P-NNN).  Returns "" if every sentence drops.

    Post-strip cleanup (2026-06-29): scrub orphan discourse-marker openers
    ("However,", "Moreover,", "Additionally,") from the first surviving
    sentence, since their referent (the preceding sentence) was just
    removed.  Surfacing "However, X happened." as a standalone sentence is
    a coherence bug.
    """
    if not citation_map or not text:
        return _scrub_orphan_opener(text)
    sentences = re.split(r"(?<=[.!?])\s+", text)
    keep: list[str] = []
    for s in sentences:
        cites = _extract_citations(s)
        if not cites:
            continue
        if not (cites & set(citation_map.keys())):
            # Cites only invalid P-NNN tokens — drop.
            continue
        keep.append(s.strip())
    if not keep:
        return ""
    # Scrub orphan opener on the first surviving sentence.
    keep[0] = _scrub_orphan_opener(keep[0])
    return " ".join(keep)


# Matches an item that is JUST a numbered prefix + citation tokens, with no
# substantive prose between them.  Examples that should be dropped:
#   '1. [P-007]'
#   '2.   [P-005, P-013]  '
#   '3. [P-001] [P-002]'  (multiple separate citation groups, no prose)
#   '4. [E-002, P-005]'   (§24 hybrid citations)
# 2026-06-29 fix after Toxic Commando / Turok regen produced empty stubs.
_EMPTY_ITEM_RE = re.compile(
    r"^\s*\d+\.\s*(?:\[(?:[PE]-\d{1,4}[\s,;]*)+\]\s*)+$",
    re.IGNORECASE,
)


def _item_has_substantive_content(item: str) -> bool:
    """True if the item has prose beyond its number prefix + citations.

    A surviving item with no actual recommendation text — e.g. just
    '1. [P-007]' after the critic stripped the prose — is worse than no
    item at all, because it surfaces a number in the UI with nothing to
    say.  Drop these.
    """
    if not item:
        return False
    return not bool(_EMPTY_ITEM_RE.match(item.strip()))


def _strip_uncited_items(text: str, citation_map: dict[str, dict]) -> str:
    """For numbered-list output: drop items whose entire body lacks a
    citation, AND items whose body is nothing but citation tokens with no
    substantive prose.  Renumbers survivors.  Returns "" if every item drops.
    """
    if not citation_map or not text:
        return text
    valid = set(citation_map.keys())
    items: list[str] = []
    current: list[str] = []

    def flush():
        nonlocal current
        if not current:
            return
        item = " ".join(current).strip()
        cites = _extract_citations(item)
        if not (cites and (cites & valid)):
            current = []
            return
        # Reject items that have only citation tokens after the number prefix.
        if not _item_has_substantive_content(item):
            logger.info(
                "Dropping empty-stub recommendation (citation-only): %s", item,
            )
            current = []
            return
        items.append(item)
        current = []

    for line in text.split("\n"):
        if re.match(r"^\s*\d+\.\s", line):
            flush()
            current.append(line.strip())
        elif line.strip():
            current.append(line.strip())
        else:
            flush()
    flush()
    if not items:
        return ""
    out: list[str] = []
    for n, item in enumerate(items, 1):
        cleaned = re.sub(r"^\s*\d+\.\s*", "", item)
        out.append(f"{n}. {cleaned}")
    return "\n\n".join(out)


def _strip_uncited_bold_ideas(
    ideas: list[str], citation_map: dict[str, dict],
) -> list[str]:
    """Drop any bold idea that lacks a valid citation."""
    if not citation_map or not ideas:
        return ideas
    valid = set(citation_map.keys())
    surviving: list[str] = []
    for idea in ideas:
        cites = _extract_citations(idea)
        if cites and (cites & valid):
            surviving.append(idea)
    return surviving


# ── Self-criticism pass (layer 4) ────────────────────────────────────────────

_SELF_CRIT_MAX_TOKENS = 400
_SELF_CRIT_SENTENCE_DELIM = "###~SENT~###"  # unlikely to appear in real text


def _self_criticize(
    client,
    text: str,
    citation_map: dict[str, dict],
    block_kind: str,  # "exec_summary" | "recommendations" | "bold_ideas"
) -> str:
    """Run a 2nd Claude call asking it to flag any sentence that is NOT
    supported by the post text it cites.  Strips unsupported sentences.

    Skipped silently when:
      • citation_map is empty (no posts to validate against)
      • text is empty (nothing to check)
      • the call raises (we keep the LLM's first-pass output rather than
        wipe everything because a critic call failed)
    """
    if not text or not citation_map:
        return text
    # Build a compact "post text" lookup for the prompt
    posts_lookup: list[str] = []
    for cite, post in citation_map.items():
        # Use a slightly longer slice in the critic prompt than in the main
        # prompt so the critic has more context to verify against.
        snippet = " ".join((post.get("text") or "").split())[:500]
        posts_lookup.append(f"  [{cite}] {snippet}")
    posts_block = "\n".join(posts_lookup)

    # 2026-06-29 (§21g): bold_ideas is interpretive by design — it proposes
    # marketing/community moves, not factual claims.  Using the SAME strict
    # standard as exec_summary destroyed 60–100% of ideas across substantive
    # titles in the live trace.  Bold ideas get a relaxed "is the cited
    # entity or topic actually referenced in the post?" test.  Exec and
    # recommendations keep the strict standard.
    if block_kind == "bold_ideas":
        crit_prompt = (
            "You are a citation-relevance reviewer for STRATEGIC BOLD IDEAS "
            "(speculative marketing/community moves anchored on community "
            "signal).  Bold ideas are interpretive by design — do NOT apply "
            "strict fact-check criteria.\n\n"
            "For each bold idea below, mark SUPPORTED if any of:\n"
            "  • The idea cites a [P-NNN] post whose text mentions or relates "
            "to the entity, person, comparison, or topic the idea references.\n"
            "  • The idea names a specific entity (person, product, comparison, "
            "event) and the cited post mentions that entity OR a clearly-"
            "related concept.\n"
            "  • The idea proposes a marketing move (Lean into, Amplify, "
            "Spotlight, Partner with, Launch, Host) and the cited post "
            "contains community signal that the move would address or "
            "capitalize on.\n\n"
            "Mark UNSUPPORTED ONLY when:\n"
            "  • The idea cites no [P-NNN] post at all.\n"
            "  • The idea cites a [P-NNN] post whose text is COMPLETELY "
            "unrelated to the idea's subject (no entity overlap, no topical "
            "connection, no plausible interpretive bridge).\n"
            "  • The idea makes a hard date/version/release-window claim "
            "that the cited post does not contain.\n\n"
            "Bold ideas are NOT statements of fact — they are strategic "
            "proposals.  Topical proximity IS support.  Lean SUPPORTED when "
            "the cited post and the idea share an entity or theme.\n\n"
            f"BLOCK KIND: {block_kind}\n\n"
            "SOURCE POSTS (the only admissible evidence):\n"
            f"{posts_block}\n\n"
            "TEXT TO VERIFY (each sentence delimited by "
            f"{_SELF_CRIT_SENTENCE_DELIM} ):\n"
        )
    else:
        crit_prompt = (
            "You are a STRICT fact-checking pass.  An earlier LLM produced the "
            "text below and tagged each claim with a citation in square brackets "
            "pointing to a source post.  Your job is to verdict each sentence (or "
            "numbered item) as SUPPORTED or UNSUPPORTED by the post(s) it cites.\n\n"
            "Core rules:\n"
            "- A sentence is SUPPORTED only if the post it cites genuinely contains "
            "the specific claim being made.  Topical proximity is NOT support.\n"
            "- Do not bring in outside knowledge.  Only the post text shown below "
            "is admissible evidence.\n"
            "- If a sentence cites multiple posts, support from any ONE of them is "
            "enough; the sentence is SUPPORTED.\n"
            "- If the sentence cites a post that does not contain the claim, UNSUPPORTED.\n"
            "- If the sentence has no citation at all, UNSUPPORTED.\n\n"
            "Specific-entity grounding (CLAUDE.md §20, hardened 2026-06-28):\n"
            "- If the sentence names a SPECIFIC mechanic, feature, or system "
            "(e.g. 'difficulty settings', 'matchmaking', 'weapon balance', 'Siege "
            "mode', 'stratagem stacking'), the cited post must literally name that "
            "same mechanic or use words clearly referring to it.  Generic complaints "
            "('it looks generic', 'disappointed in gameplay', 'window dressing') do "
            "NOT support a specific-mechanic recommendation.  UNSUPPORTED.\n"
            "- If the sentence claims a DATE, DEADLINE, RELEASE WINDOW, or version "
            "number ('before October release', 'by Q1', 'in patch 14', 'within 2 "
            "weeks'), the cited post must literally contain that date/version, or "
            "the sentence is UNSUPPORTED.  The current date or general industry "
            "knowledge is not admissible.\n"
            "- If the sentence prescribes a POST-LAUNCH action ('patch', 'hotfix', "
            "'rebalance', 'update the live game') and the cited post is clearly "
            "discussing a pre-release game (mentions trailers, reveals, wishlist, "
            "announcement, 'looking forward', 'looks like it will', 'after seeing "
            "gameplay', 'preview'), mark UNSUPPORTED.  A game that is not out "
            "cannot be patched.\n"
            "- When in doubt, UNSUPPORTED.  Saying nothing is preferred over saying "
            "something the post does not support.\n\n"
            f"BLOCK KIND: {block_kind}\n\n"
            "SOURCE POSTS (the only admissible evidence):\n"
            f"{posts_block}\n\n"
            "TEXT TO VERIFY (sentences are separated by the delimiter "
            f"{_SELF_CRIT_SENTENCE_DELIM} ):\n"
        )

    # Split into sentence-level chunks with a stable delimiter so we can
    # parse the critic's verdicts back into our sentence list.
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    if not sentences:
        return text
    crit_prompt += (
        _SELF_CRIT_SENTENCE_DELIM.join(sentences) + "\n\n"
        "Output: one line per sentence in the same order as above, "
        "either:\n"
        "  SUPPORTED\n"
        "  UNSUPPORTED <one-line reason citing which cited post failed>\n"
        "No preamble.  No markdown.  Exactly one line per sentence."
    )

    try:
        message = client.messages.create(
            model=_MODEL,
            max_tokens=_SELF_CRIT_MAX_TOKENS,
            messages=[{"role": "user", "content": crit_prompt}],
        )
        verdicts = message.content[0].text.strip().split("\n")
    except Exception as exc:
        logger.warning("Self-criticism pass raised, keeping first-pass output: %s", exc)
        return text

    if len(verdicts) < len(sentences):
        # Critic returned malformed output (fewer verdicts than sentences).
        # Don't risk dropping good content — keep original.
        logger.warning(
            "Self-criticism returned %d verdicts for %d sentences; keeping original",
            len(verdicts), len(sentences),
        )
        return text

    keep: list[str] = []
    for sent, verdict in zip(sentences, verdicts):
        v = verdict.strip().upper()
        if v.startswith("SUPPORTED"):
            keep.append(sent)
        else:
            logger.info(
                "Self-criticism dropping unsupported sentence: %s | reason=%s",
                sent[:120], verdict.strip()[:200],
            )
    if not keep:
        # Every sentence rejected — fall back to a low-signal placeholder.
        return ""
    return " ".join(keep)


def _self_criticize_items(
    client, text: str, citation_map: dict[str, dict], block_kind: str,
) -> str:
    """Sentence-equivalent for numbered-item output (recommendations).
    Treats each numbered item as a "sentence" for criticism purposes.
    Renumbers survivors."""
    if not text or not citation_map:
        return text
    # Split into numbered items
    items: list[str] = []
    current: list[str] = []
    for line in text.split("\n"):
        if re.match(r"^\s*\d+\.\s", line):
            if current:
                items.append(" ".join(current).strip())
                current = []
            current.append(line.strip())
        elif line.strip():
            current.append(line.strip())
    if current:
        items.append(" ".join(current).strip())
    if not items:
        return text

    # Strip numbering for criticism (it's noise to the critic)
    naked_items = [re.sub(r"^\s*\d+\.\s*", "", item) for item in items]
    joined = (" " + _SELF_CRIT_SENTENCE_DELIM + " ").join(naked_items) + "."
    survived = _self_criticize(client, joined, citation_map, block_kind)
    if not survived:
        return ""
    # Re-split on the delimiter to recover items
    surviving_items = [s.strip().rstrip(".") for s in survived.split(_SELF_CRIT_SENTENCE_DELIM) if s.strip()]
    if not surviving_items:
        return ""
    # CLAUDE.md §22 (2026-06-29): the critic may have stripped the prose
    # from an item while leaving its citation tokens.  Re-check each
    # survivor and drop items that are now nothing but citations.
    cleaned: list[str] = []
    for n, item in enumerate(surviving_items, 1):
        candidate = f"{n}. {item}"
        if _item_has_substantive_content(candidate):
            cleaned.append(item)
        else:
            logger.info(
                "§22 dropping post-critic empty-stub item (%s): %s",
                block_kind, candidate,
            )
    if not cleaned:
        return ""
    return "\n\n".join(f"{n}. {item}" for n, item in enumerate(cleaned, 1))


# Orphan-pronoun / dangling-reference detection (2026-06-28 hardening).
# A bold idea that starts a clause with an unanchored "this X" or "the X"
# is incoherent to the reader because we cannot see what "X" was supposed
# to refer to.  We drop such ideas outright — surfacing a confusing
# sentence is worse than surfacing nothing.
# 2026-06-29 NARROWING (§21c+§22 follow-up):
# The prior list (analog, analogy, comparison, reference, approach, signal,
# entity, trend, pattern, issue, complaint, concern, topic, criticism,
# sentiment, demand, interest, reception, theme, narrative, argument) was
# far too broad — it dropped EVERY bold idea across SM2, Hellraiser, and
# Bus Bound because almost any community-marketing prose naturally uses
# phrases like "this trend", "the demand", "the reception", or "this
# issue" as natural English without those being orphan references.
#
# The ACTUAL failure mode this guard was built for (per L20 2026-06-28):
# the critic stripped the introducing sentence of a 2-sentence idea
# leaving an orphan "this analog" / "this comparison" lead in the second
# sentence.  We only need to catch those specific tight-meaning anaphors,
# AND only when they appear NEAR THE START of the idea (within the first
# 80 characters) — a "this trend" appearing later in a 30-word idea is
# almost always backref-able to earlier prose.
_ORPHAN_REFERENCE_PATTERNS = (
    re.compile(
        r"\b(?:this|that)\s+"
        r"(?:analog|analogy|comparison|reference)\b",
        re.I,
    ),
)

_INTRODUCING_VERB_RE = re.compile(
    r"\b(?:reject(?:ed)?|prefer(?:red)?|compare(?:d)?|cit(?:e|ed|ing)|"
    r"name(?:d)?|mention(?:ed)?|identif(?:y|ied)|highlight(?:ed)?|"
    r"call(?:ed)?\s+out|flag(?:ged)?|introduc(?:e|ed))\b", re.I,
)


def _has_orphan_reference(idea: str) -> bool:
    """True if `idea` contains a tight orphan anaphor with no introducing
    EARLIER CLAUSE.

    NARROWED 2026-06-29: only fires for very-specific anaphors
    ("this analog", "that comparison", "this reference", "this analogy")
    — the previous broad list dropped every bold idea by flagging
    routine phrasing like "this trend", "the demand", "the reception".

    The clause-boundary logic is preserved from the original L20 fix:
    we look at clauses STRICTLY BEFORE the orphan match for an
    introducing verb (rejected/named/compared/etc.). If the introducing
    verb appears in the SAME clause as the orphan ("rejected this
    analog"), that doesn't help — "rejected" is acting ON the orphan,
    not introducing it.
    """
    if not idea:
        return False
    clauses = [c.strip() for c in re.split(r"[,;.]\s*", idea) if c.strip()]
    for i, clause in enumerate(clauses):
        for pat in _ORPHAN_REFERENCE_PATTERNS:
            if pat.search(clause):
                earlier = " ".join(clauses[:i])
                if not _INTRODUCING_VERB_RE.search(earlier):
                    return True
    return False


def _strip_orphan_reference_ideas(ideas: list[str]) -> list[str]:
    """Drop bold ideas whose only surviving clause references an antecedent
    that no earlier clause in the same idea introduced."""
    survived: list[str] = []
    for idea in ideas:
        if _has_orphan_reference(idea):
            logger.warning(
                "Dropping bold idea with orphan reference: %s", idea[:200],
            )
            continue
        survived.append(idea)
    return survived


def _self_criticize_bold_ideas(
    client, ideas: list[str], citation_map: dict[str, dict],
) -> list[str]:
    """Apply self-criticism to each bold idea.

    Atomic-unit rule WITH SALVAGE (CLAUDE.md §20+§22+§23 hardening 2026-06-29):
    Previously this dropped the entire idea if the critic rejected ANY
    sentence.  Combined with the tightened §20 critic prompt (specific-entity
    grounding, date grounding, pre-release verb rejection), that produced
    0 bold ideas across all 8 titles in the live digest — the failure the
    user just flagged.

    New behaviour: if the critic survived something with substantive content
    AND retains at least one citation marker, keep what survived.  The risk
    of orphan-pronoun artifacts ("Community explicitly rejected this
    analog…") is mitigated by:
      • _sanitize_bold_ideas (layer 2) runs AFTER this and drops ideas that
        are too short, missing citations, or read like a stub.
      • _strip_uncited_bold_ideas (layer 3) runs BEFORE this.
    Together those layers catch the dangling-reference cases while letting
    legitimate 2-sentence ideas survive when the critic finds one part
    unsupported but the other still stands on its own.

    Substantive content threshold: ≥80 chars AND ≥10 words AND contains at
    least one [P-###]-style citation marker.  Below that, drop the whole
    idea (the salvage isn't worth keeping).
    """
    if not ideas or not citation_map:
        return ideas
    survived: list[str] = []
    _citation_re = re.compile(r"\[[A-Za-z]-\d+\]")
    for idea in ideas:
        original_sents = [
            s.strip() for s in re.split(r"(?<=[.!?])\s+", idea) if s.strip()
        ]
        critiqued = _self_criticize(client, idea, citation_map, "bold_ideas")
        critiqued_sents = [
            s.strip() for s in re.split(r"(?<=[.!?])\s+", critiqued) if s.strip()
        ]
        # Critic returned nothing — every sentence rejected.  Drop the idea.
        if not critiqued.strip():
            logger.info(
                "Bold-idea critic rejected all sentences; dropping: %s",
                idea[:120],
            )
            continue
        # Partial survival: only keep if what's left is substantive AND cited.
        if len(critiqued_sents) < len(original_sents):
            has_citation = bool(_citation_re.search(critiqued))
            word_count = len(critiqued.split())
            if not has_citation or word_count < 10 or len(critiqued) < 80:
                logger.info(
                    "Bold-idea critic stripped %d/%d sentences; surviving "
                    "text too thin to keep (chars=%d words=%d cited=%s): %s",
                    len(original_sents) - len(critiqued_sents),
                    len(original_sents), len(critiqued), word_count,
                    has_citation, idea[:120],
                )
                continue
            logger.info(
                "Bold-idea critic stripped %d/%d sentences; salvaging "
                "remaining substantive text (chars=%d words=%d): %s",
                len(original_sents) - len(critiqued_sents),
                len(original_sents), len(critiqued), word_count,
                critiqued[:120],
            )
        survived.append(critiqued)
    return survived


def _format_sample_posts_block(sample_posts: dict[str, list[str]]) -> str:
    """Render sample posts as a clearly-labelled block for the prompt.

    Returns empty string if no samples exist.  Each post is preceded by its
    sentiment bucket so Claude can attribute specifics correctly.
    """
    parts: list[str] = []
    for sentiment in ("positive", "negative", "neutral"):
        posts = sample_posts.get(sentiment) or []
        if not posts:
            continue
        parts.append(f"-- {sentiment.upper()} samples --")
        for i, text in enumerate(posts, 1):
            single_line = " ".join(text.split())  # collapse whitespace
            parts.append(f"  {sentiment[0].upper()}{i}. {single_line}")
    return "\n".join(parts)


def _format_entities_block(distinctive_entities: list[str]) -> str:
    """Render distinctive entities as a comma list, or empty string if none."""
    if not distinctive_entities:
        return ""
    return ", ".join(distinctive_entities)


# Words that strongly indicate the game is NOT YET RELEASED — community is
# reacting to trailers, reveals, gameplay previews, marketing, wishlist
# pages, etc.  Used by _infer_release_status() to decide whether to allow
# post-launch verbs like 'Patch' / 'Hotfix' in recommendations.
_PRERELEASE_SIGNALS = frozenset({
    "trailer", "trailers", "reveal", "revealed", "announcement", "announced",
    "wishlist", "wishlisted", "preview", "previews", "showcase", "reveal trailer",
    "looking forward", "can't wait", "hyped", "upcoming", "pre-order", "preorder",
    "coming soon", "release date", "release window", "launches", "launch date",
    "after seeing gameplay", "based on the trailer", "first look", "summer game fest",
    "sgf", "gamescom", "the game awards", "tga reveal", "announce trailer",
    "gameplay reveal", "gameplay preview", "dev diary", "dev diaries",
    "behind the scenes", "sizzle reel", "teaser",
})

# Words that strongly indicate the game IS RELEASED and community is
# discussing the live game (patches, performance, multiplayer activity, etc.)
_POSTRELEASE_SIGNALS = frozenset({
    "patch", "patches", "patched", "hotfix", "hotfixed", "update", "updated",
    "nerfed", "buffed", "meta", "current meta", "grinding", "grind", "endgame",
    "servers", "server down", "matchmaking", "queue times", "disconnect",
    "disconnected", "crashes", "crashing", "performance issues", "fps drops",
    "frame drops", "latest patch", "this patch", "current patch",
    "after the update", "since the patch", "prestige", "battle pass",
    "season pass", "current season", "playing it now", "hours played",
    "already played", "finished the campaign", "beat the boss",
})


def _infer_release_status(samples_block: str) -> str:
    """Best-effort label for whether the game is pre-release or live, based
    on the language used in the sample posts.  Returns one of:
        "pre-release"  — strong pre-release signal, do not allow patch/hotfix
        "released"     — strong post-release signal, allow patch/hotfix
        "unclear"      — neither strong signal; let the LLM choose conservatively

    Heuristic: count case-insensitive substring hits of the two signal sets in
    the samples block.  This isn't perfect (e.g. a released game can still
    have 'release date' chatter for a DLC) but it's directionally correct on
    every title in the priority list and turns the violations the user just
    caught into unambiguous critic flags.
    """
    if not samples_block:
        return "unclear"
    haystack = samples_block.lower()
    pre = sum(1 for w in _PRERELEASE_SIGNALS if w in haystack)
    post = sum(1 for w in _POSTRELEASE_SIGNALS if w in haystack)
    if pre >= 2 and pre > post * 2:
        return "pre-release"
    if post >= 2 and post > pre * 2:
        return "released"
    return "unclear"


def _release_status_clause(status: str) -> str:
    """Return a prompt fragment instructing the LLM to choose verbs and
    actions appropriate to whether the game is shipped."""
    if status == "pre-release":
        return (
            "GAME RELEASE STATUS: PRE-RELEASE (community is reacting to trailers, "
            "reveals, previews, or marketing — the game is NOT YET PLAYABLE).\n"
            "- DO NOT use verbs that imply the game is live: Patch, Hotfix, "
            "Rebalance, Nerf, Buff, Ship Update, Roll Back, Revert.\n"
            "- DO NOT reference patch versions, balance passes, server issues, "
            "matchmaking, or performance unless the community explicitly raised "
            "them about a public demo or beta.\n"
            "- Allowed verbs: Clarify, Communicate, Reframe, Showcase, Address, "
            "Document, Publish, Reveal, Demonstrate, Counter-position, Reassure.\n"
            "- Recommendations must target MARKETING, MESSAGING, COMMUNITY, and "
            "PR levers — not gameplay fixes that cannot exist yet.\n\n"
        )
    if status == "released":
        return (
            "GAME RELEASE STATUS: LIVE / RELEASED (community is discussing the "
            "actual playable game). Patch, Hotfix, Rebalance, and live-game "
            "verbs are all appropriate when the data supports them.\n\n"
        )
    # unclear
    return (
        "GAME RELEASE STATUS: UNCLEAR. If you are not certain the game is live, "
        "avoid prescribing post-launch fixes (Patch, Hotfix, Rebalance).  When "
        "in doubt, recommend communication or messaging actions instead.\n\n"
    )


# CLAUDE.md §21 (Commercial Strategic Context, 2026-06-29).
#
# Failure mode that triggered this: the Hellraiser weekly recommendation
# advised the team to "counter-position" the game away from Resident Evil
# comparisons.  RE Requiem is the #1 commercial game of 2026 (7M+ units in
# 2 months, Metacritic 90s, fastest-selling RE ever).  Being compared to
# the year's biggest commercial horror release is a STRATEGIC ASSET, not a
# liability.  The right play is lean-into-and-add ("yes-and"), not
# counter-positioning.  The system had no way to see this because it
# treated every community signal as a thing to react to, not as something
# that might be commercially valuable on its own.
#
# Fix: every prompt gets two new clauses:
#   1. _commercial_context_clause(brief)  — per-title positioning brief
#      that names commercial benchmarks to amplify, tailwinds to ride, and
#      threats to differentiate from.  Read from Game.commercial_context.
#   2. _signal_classification_clause()    — forces the LLM to classify each
#      community signal as ASSET / LIABILITY / NEUTRAL before recommending
#      an action, and biases the verb list toward "amplify" for assets.

_SIGNAL_CLASSIFICATION_CLAUSE = (
    "COMMUNITY SIGNAL CLASSIFICATION (HARD RULE):\n"
    "Before recommending any action on a community signal, classify it:\n"
    "  - ASSET: a positive commercial comparison (\"reminds me of "
    "[commercial hit X]\"), strong IP recognition, demand for specific "
    "franchise touchstones, organic genre tailwind. → AMPLIFY, do NOT "
    "counter-position.  Recommended verbs: Lean into, Amplify, Double down, "
    "Anchor on, Spotlight, Embrace.\n"
    "  - LIABILITY: legitimate quality concern, broken expectation, real "
    "complaint, regional content gap, localization issue, missing feature, "
    "performance problem, communication gap. → ADDRESS, fix, or clarify. "
    "Verbs: Patch (released games only), Clarify, Address, Document, "
    "Reframe, Resolve, Communicate.\n"
    "  - NEUTRAL: noise, generic chatter, comparison-shopping without "
    "emotional charge. → MONITOR (do not surface as a recommendation).\n"
    "\n"
    "BALANCE REQUIREMENT (DO NOT SKEW): produce a MIX of asset-amplify and "
    "liability-address recommendations.  Honest reporting > white-washing.  "
    "BUT: only recommend action on a LIABILITY topic when that topic appears "
    "in the critical-mass table below as tier='theme'.  Topics marked "
    "tier='monitor-only' are real signals but too thin (single poster, one "
    "day) to justify a strategic recommendation — list them in the exec "
    "summary as context if helpful, but do NOT write a numbered recommendation "
    "about them.  Goal: every recommendation is about a theme with real "
    "recurrence or volume.\n"
    "\n"
    "If after applying the critical-mass filter no LIABILITY-class "
    "recommendations remain, that is fine — it just means the negative signal "
    "in this window was thin.  Better to ship 2-3 strong recommendations on "
    "real themes than 4-5 recommendations that include responses to single-"
    "poster issues.\n"
    "\n"
    "CRITICAL on COMPARISONS specifically: a community comparison to a "
    "current commercial success in the same genre is an ASSET, not a "
    "liability — even when the comment sounds skeptical (e.g. \"this looks "
    "like another Resident Evil\").  The market is telling you the comparison "
    "resonates.  Recommend AMPLIFYING the comparison + ADDING what makes this "
    "title authentic, NOT distancing from it.  This rule applies ONLY to "
    "market-leader comparisons — it does NOT apply to legitimate complaints "
    "about quality, content, or service.  Those remain LIABILITIES.\n\n"
)


def _commercial_context_clause(brief: Optional[str]) -> str:
    """Inject the per-title positioning brief if set, else fall back to a
    short generic reminder that the LLM should think commercially."""
    if brief and brief.strip():
        return (
            "COMMERCIAL STRATEGIC CONTEXT (per-title brief):\n"
            f"{brief.strip()}\n\n"
            "Read this brief BEFORE making any recommendation.  When the "
            "community signal aligns with a tailwind named in the brief, "
            "AMPLIFY — do not counter-position.  When it aligns with a named "
            "threat to differentiate from, address it.\n\n"
        )
    # No brief set — emit a generic reminder.  Better than nothing.
    return (
        "COMMERCIAL STRATEGIC THINKING:\n"
        "Before recommending an action on a community comparison, consider "
        "whether the entity being compared to is a CURRENT commercial "
        "success in the same genre.  If yes, the comparison is most likely "
        "a tailwind to amplify, not a liability to deflect.  Do not advise "
        "the team to distance from a comparison to a market-leading title "
        "in the same genre — advise them to lean in and differentiate on "
        "authenticity or IP-specific strengths.\n\n"
    )


def _anti_fabrication_clause(
    samples_block: str,
    entities_block: str,
) -> str:
    """Return the shared 'never fabricate names' instruction.

    REGRESSION (2026-06-24, Hellraiser): the live Hellraiser digest cited
    "Jamie Clayton voice casting" in recommendations + bold ideas.  Ground
    truth in raw_posts: zero posts mention Clayton; one post explicitly
    says "Doug Bradley returns to voice Pinhead".  The model autocompleted
    Clayton from background knowledge of the 2022 reboot film, because the
    actions + bold-ideas prompts told it to "reference a SPECIFIC entity"
    without constraining specifics to the input.

    The exec-summary prompt already has an anti-fabrication rule for this
    reason — it must be repeated in every prompt that asks for specifics.
    """
    # If we have nothing concrete to anchor on, do not invite specifics at all.
    if not (samples_block or entities_block):
        return (
            "NO SPECIFICS AVAILABLE: sample posts and distinctive entities are both empty. "
            "Do NOT invent named entities (people, characters, DLC, levels, patches, modes). "
            "If you cannot honestly anchor on something from the data, respond NONE.\n\n"
        )
    return (
        "ANTI-FABRICATION RULES (HARD):\n"
        "- You MAY ONLY reference proper-noun entities (people's names, character names, DLC\n"
        "  names, patch versions, mode names, level names, weapon names, etc.) that appear\n"
        "  verbatim in the DISTINCTIVE ENTITIES list OR the REPRESENTATIVE SAMPLE POSTS\n"
        "  below.\n"
        "- Do NOT invoke ANY background knowledge about the franchise, its prior games,\n"
        "  its movies, its actors, or its lore. If the community didn't talk about it in\n"
        "  the data shown, it does not exist for the purposes of this output.\n"
        "- Real example of the failure mode: an earlier output suggested partnering with a\n"
        "  voice actor from the franchise's MOVIES who was never mentioned by the community,\n"
        "  while ignoring the actor the community actually praised. Do not do this.\n"
        "- If you cannot find a proper-noun entity in the provided data, fall back to a\n"
        "  topic label from the topics lists (positive/negative/neutral topics), or respond\n"
        "  NONE if even that is not actionable.\n\n"
    )


# ── Post-LLM fact-check gate ──────────────────────────────────────────────────
# CLAUDE.md §20 (Confirm-or-Omit) prompt-level rules + this post-LLM filter
# together form a belt-and-suspenders guard against the model fabricating
# named entities from its background knowledge of the franchise.
#
# The 2026-06-24 Hellraiser regression demonstrated that prompt instructions
# alone are insufficient: even after adding an explicit anti-fabrication
# clause to every prompt, Claude still surfaced "Jamie Clayton voicing
# Pinhead" because she is strongly associated with the Hellraiser franchise
# in its training data.  Prompt rules nudge the model; this gate ENFORCES.

# Common English / calendar words that look like proper nouns but aren't
# entities.  These are allowed through the gate without being in the input.
_COMMON_CAPITALIZED = frozenset({
    # Months
    "january", "february", "march", "april", "may", "june", "july",
    "august", "september", "october", "november", "december",
    # Days
    "monday", "tuesday", "wednesday", "thursday", "friday",
    "saturday", "sunday",
    # Sentence-leading words that auto-capitalize
    "the", "a", "an", "and", "or", "but", "if", "when", "while", "this",
    "that", "these", "those", "their", "his", "her", "they", "we", "you",
    "i", "it", "is", "are", "was", "were", "early", "late", "first",
    "second", "third", "many", "most", "some", "any", "no", "yes",
    # Gaming-platform / generic terms
    "steam", "playstation", "ps5", "ps4", "xbox", "pc", "switch", "epic",
    "reddit", "bluesky", "youtube", "twitch", "discord", "twitter",
    "tiktok", "facebook", "instagram", "north", "south", "east", "west",
    # 2026-06-29 (§21g): bolded-entity extractor was including the leading
    # verb of bolded phrases (e.g. **Amplify Welsh VO**) and flagging the
    # verb as a fabrication.  Add the bold-idea imperative-verb vocabulary
    # here so verbs are never treated as fabricated proper nouns.
    "lean", "amplify", "double", "anchor", "spotlight", "embrace",
    "capitalize", "leverage", "harness", "elevate", "champion",
    "highlight", "emphasize", "partner", "collaborate", "sponsor",
    "host", "launch", "run", "organize", "feature", "promote",
    "distribute", "seed", "cultivate", "grow", "recruit", "invite",
    "create", "build", "design", "produce", "publish", "release",
    "reveal", "drop", "ship", "clarify", "communicate", "document",
    "showcase", "reassure", "announce", "share", "update", "explain",
    "confirm", "acknowledge", "respond", "reframe", "reposition",
    "audit", "investigate", "review", "analyze", "measure",
    "benchmark", "track", "monitor", "surface", "expose", "probe",
    "examine", "profile", "diagnose", "test", "experiment", "pilot",
    "prototype", "trial", "invest", "expand", "sunset", "deploy",
    "pivot", "tie", "connect", "bridge", "introduce", "address",
    "patch", "hotfix", "rebalance", "nerf", "buff", "resolve",
    "prioritize",
    # Common business / marketing abbreviations that look like proper nouns
    "pr", "qa", "ux", "ui", "ip", "dlc", "vo", "ai", "ml", "ar", "vr",
    "hr", "ceo", "cto", "cmo", "pm", "kpi", "roi", "ttv", "mau", "dau",
    "ccu", "faq", "api", "sdk", "cdn", "crm", "saas", "b2b", "b2c",
    "ftue", "qoq", "yoy", "mtd", "ytd", "mvp", "poc", "rfp", "oem",
})

# Tokens to extract for whitelist building.  Keep alphanumerics, apostrophes,
# hyphens.  Letters-only check for "is this a proper noun candidate" comes
# afterwards.
_WORD_TOKEN_RE = re.compile(r"[A-Za-z0-9'\-]+")

# Capitalized-token check for candidate extraction: a leading uppercase letter
# followed by more letters (covers "Clayton", "Pinhead", "Hellraiser") but
# NOT all-caps acronyms (which the model rarely fabricates) and NOT single
# capital letters.
_PROPER_NOUN_RE = re.compile(r"^[A-Z][a-zA-Z']+$")


def _build_input_whitelist(
    game_name: str,
    sample_posts: dict[str, list[str]],
    distinctive_entities: list[str],
    topic_labels: Optional[list[str]] = None,
    editorial_articles: Optional[list] = None,
) -> set[str]:
    """Lowercase-word whitelist drawn from every input the LLM saw.

    Anything in the LLM's output that appears here (case-insensitive) is
    considered grounded in the data.  Anything not here is a fabrication
    candidate.

    §24e (2026-06-29): editorial article titles, publications, summaries,
    AND body text contribute to the whitelist.  Bold ideas now reason on
    editorial content (e.g. 'Doom 2016', 'Tek Bow', 'Codex variants'),
    so those nouns appear in editorial bodies and MUST be whitelisted to
    avoid being flagged as fabrications.
    """
    whitelist: set[str] = set(_COMMON_CAPITALIZED)
    sources: list[str] = []
    sources.append(game_name or "")
    for bucket in (sample_posts or {}).values():
        sources.extend(bucket)
    sources.extend(distinctive_entities or [])
    sources.extend(topic_labels or [])
    # §24e: editorial articles contribute every token in their titles,
    # publications, summaries, and bodies.
    for art in editorial_articles or []:
        for field in ("title", "publication", "summary", "body"):
            val = getattr(art, field, None)
            if val:
                sources.append(val)
    for src in sources:
        for tok in _WORD_TOKEN_RE.findall(src):
            # 2026-06-29 (§21g): add both the bare form and the possessive
            # form so a candidate like "Jeff's" matches when the post has
            # "Jeff".  Likewise add the bare form when the source has the
            # possessive.  This closes the "Jeff's flagged as fabrication"
            # bug exposed by the bold-ideas live trace.
            t = tok.lower()
            whitelist.add(t)
            if t.endswith("'s"):
                whitelist.add(t[:-2])
            else:
                whitelist.add(t + "'s")
    return whitelist


def _extract_proper_noun_candidates(text: str) -> list[str]:
    """Return capitalized proper-noun-shaped tokens that appear in `text`
    in positions where they are likely to be entity references, not
    sentence-start capitalization artifacts.

    Strategy:
      • Every bolded entity (**X**) contributes its capitalized tokens.
      • Every non-sentence-start capitalized token in the prose contributes.
    """
    cands: set[str] = set()
    # Bolded entities first — these are unambiguously entity references in
    # our prompt format.
    for m in re.finditer(r"\*\*([^*]+)\*\*", text):
        for tok in _WORD_TOKEN_RE.findall(m.group(1)):
            if _PROPER_NOUN_RE.match(tok):
                cands.add(tok)
    # Mid-sentence capitalized tokens in the rest of the prose.
    # Split on sentence boundaries then look at words 2..N (word 1 may be
    # capitalized due to sentence-initial position, not because it's a name).
    for sent in re.split(r"(?<=[.!?])\s+", text):
        # Drop a leading numbered-list marker like "1. " or "2) "
        sent = re.sub(r"^\s*\d+[\.\)]\s*", "", sent)
        tokens = _WORD_TOKEN_RE.findall(sent)
        for i, tok in enumerate(tokens):
            if i == 0:
                continue
            if _PROPER_NOUN_RE.match(tok):
                cands.add(tok)
    return sorted(cands)


def _fact_check_for_fabrications(
    text: str,
    game_name: str,
    sample_posts: dict[str, list[str]],
    distinctive_entities: list[str],
    topic_labels: Optional[list[str]] = None,
    editorial_articles: Optional[list] = None,
) -> list[str]:
    """Return the list of fabricated proper nouns found in `text`.

    A fabrication is a capitalized proper-noun-shaped token in `text` whose
    lowercased form does NOT appear anywhere in the LLM's input data.

    Empty list means the output passes the fact check.
    """
    if not text:
        return []
    whitelist = _build_input_whitelist(
        game_name, sample_posts, distinctive_entities, topic_labels,
        editorial_articles=editorial_articles,
    )
    candidates = _extract_proper_noun_candidates(text)
    return [c for c in candidates if c.lower() not in whitelist]


def _sanitize_recommendations(
    text: str,
    game_name: str,
    sample_posts: dict[str, list[str]],
    distinctive_entities: list[str],
    topic_labels: Optional[list[str]] = None,
    editorial_articles: Optional[list] = None,
) -> str:
    """Drop any numbered recommendation line containing a fabricated name.

    Numbered lists are line-oriented — we can surgically remove just the
    offending item and renumber the survivors.  If sanitization removes
    EVERY item, returns "" so the caller can fall back to NONE.
    """
    fabs = _fact_check_for_fabrications(
        text, game_name, sample_posts, distinctive_entities, topic_labels,
        editorial_articles=editorial_articles,
    )
    if not fabs:
        return text
    fab_set = {f.lower() for f in fabs}
    logger.warning(
        "Fact-check dropping recommendations containing fabricated names: %s",
        fabs,
    )
    # Split into lines, identify which lines contain fab names, drop them.
    surviving: list[str] = []
    current_item: list[str] = []
    def flush():
        nonlocal current_item
        if not current_item:
            return
        item_text = " ".join(current_item)
        item_tokens = {t.lower() for t in _WORD_TOKEN_RE.findall(item_text)}
        if item_tokens & fab_set:
            current_item = []
            return
        surviving.append(item_text)
        current_item = []
    for line in text.split("\n"):
        if re.match(r"^\s*\d+\.\s", line):
            flush()
            current_item.append(line.strip())
        elif line.strip():
            current_item.append(line.strip())
        else:
            flush()
    flush()
    if not surviving:
        return ""
    # Renumber.
    out_lines: list[str] = []
    n = 1
    for s in surviving:
        # Strip the existing "N. " prefix if present, re-prefix with new number.
        s_clean = re.sub(r"^\s*\d+\.\s*", "", s)
        out_lines.append(f"{n}. {s_clean}")
        n += 1
    return "\n\n".join(out_lines)


# Post-launch verbs / phrases that imply the game is live and patchable.
# Hardened 2026-06-28 after Hellraiser (unreleased) got a "Patch Game
# Difficulty Settings ... before October release window" recommendation.
_POST_LAUNCH_VERB_PATTERNS = (
    re.compile(r"^\s*\d+\.\s*\*?\*?(patch|hotfix|rebalance|nerf|buff|revert|roll\s*back|ship\s+update)\b", re.I),
    re.compile(r"\b(balance\s+pass|live\s+game|live\s+server|matchmaking\s+queue|server\s+stability)\b", re.I),
    re.compile(r"\bbefore\s+(?:the\s+)?(?:october|november|december|january|february|march|april|may|june|july|august|september)\s+release", re.I),
)


def _sanitize_recommendations_for_release_status(text: str, release_status: str) -> str:
    """Drop numbered recommendations that prescribe a post-launch action when
    the game is detected as pre-release.  Belt-and-suspenders alongside the
    prompt instruction in _release_status_clause and the layer-4 critic.

    A 'patch'/'hotfix'/'rebalance' recommendation against a game that has
    not shipped is the canonical §20 violation we want to make impossible.
    """
    if release_status != "pre-release" or not text:
        return text
    items: list[str] = []
    current_item: list[str] = []
    def flush():
        nonlocal current_item
        if not current_item:
            return
        item_text = "\n".join(current_item)
        for pat in _POST_LAUNCH_VERB_PATTERNS:
            if pat.search(item_text):
                logger.warning(
                    "Release-status sanitizer dropping pre-release recommendation: %s",
                    item_text[:200],
                )
                current_item = []
                return
        items.append(item_text)
        current_item = []
    for line in text.split("\n"):
        if re.match(r"^\s*\d+\.\s", line):
            flush()
            current_item.append(line)
        else:
            current_item.append(line)
    flush()
    if not items:
        return ""
    # Renumber survivors.
    out_lines: list[str] = []
    n = 1
    for it in items:
        cleaned = re.sub(r"^\s*\d+\.\s*", "", it.strip())
        out_lines.append(f"{n}. {cleaned}")
        n += 1
    return "\n\n".join(out_lines)


def _enforce_editorial_grounding(
    ideas: list[str],
    citation_map: dict[str, dict],
    *,
    editorial_available: bool,
) -> list[str]:
    """§24c gate: when editorial articles are available for this title,
    every surviving bold idea MUST cite at least one [E-NNN] (editorial
    context) AND at least one [P-NNN] (post anchor).

    This enforces the "bridge" rule from the prompt: the bold idea uses
    editorial signal to address a community theme.  Editorial-only or
    post-only ideas are dropped here.

    When editorial is NOT available (or the citation map has no E-NNN
    entries), this is a no-op: legacy P-only behaviour applies.
    """
    if not ideas:
        return ideas
    if not editorial_available:
        return ideas
    # If for some reason the citation_map has zero editorial entries even
    # though editorial_available is True, fall back to no-op rather than
    # nuking every idea.
    has_e_in_map = any(k.startswith("E-") for k in citation_map.keys())
    if not has_e_in_map:
        return ideas
    surviving: list[str] = []
    for idea in ideas:
        cites = _extract_citations(idea)
        has_p = any(c.startswith("P-") for c in cites)
        has_e = any(c.startswith("E-") for c in cites)
        if has_p and has_e:
            surviving.append(idea)
        else:
            missing = []
            if not has_p:
                missing.append("[P-NNN]")
            if not has_e:
                missing.append("[E-NNN]")
            logger.warning(
                "§24c grounding gate dropping idea (missing %s): %s",
                "+".join(missing), idea[:140],
            )
    return surviving


def _sanitize_bold_ideas(
    ideas: list[str],
    game_name: str,
    sample_posts: dict[str, list[str]],
    distinctive_entities: list[str],
    topic_labels: Optional[list[str]] = None,
    editorial_articles: Optional[list] = None,
) -> list[str]:
    """Drop any bold idea that contains a fabricated proper noun."""
    if not ideas:
        return ideas
    surviving: list[str] = []
    for idea in ideas:
        fabs = _fact_check_for_fabrications(
            idea, game_name, sample_posts, distinctive_entities, topic_labels,
            editorial_articles=editorial_articles,
        )
        if fabs:
            logger.warning(
                "Fact-check dropping bold idea containing fabricated names %s: %s",
                fabs, idea[:120],
            )
            continue
        surviving.append(idea)
    return surviving


def _sanitize_executive_summary(
    text: str,
    game_name: str,
    sample_posts: dict[str, list[str]],
    distinctive_entities: list[str],
    topic_labels: Optional[list[str]] = None,
    editorial_articles: Optional[list] = None,
) -> str:
    """Drop any sentence in the executive summary that contains a fabricated
    proper noun.  Unlike recommendations, the exec summary is free prose, so
    sentence-level surgery is the finest viable cut.

    If sanitization removes every sentence, returns a short honest note.
    """
    fabs = _fact_check_for_fabrications(
        text, game_name, sample_posts, distinctive_entities, topic_labels,
        editorial_articles=editorial_articles,
    )
    if not fabs:
        return text
    fab_set = {f.lower() for f in fabs}
    logger.warning(
        "Fact-check dropping exec-summary sentences containing fabricated names: %s",
        fabs,
    )
    sentences = re.split(r"(?<=[.!?])\s+", text)
    keep: list[str] = []
    for s in sentences:
        s_tokens = {t.lower() for t in _WORD_TOKEN_RE.findall(s)}
        if s_tokens & fab_set:
            continue
        keep.append(s.strip())
    if not keep:
        return (
            "Community sentiment was mixed during this window, but specific "
            "entity-level claims could not be confirmed from the available "
            "posts.  See topic breakdowns for grounded detail."
        )
    return " ".join(keep)


def _strip_monitor_only_lead(text: str, monitor_topic_labels: list[str]) -> str:
    """If the lead sentence is dominated by a monitor-only topic label, drop it.

    CLAUDE.md §21b (2026-06-29): a monitor-only topic must not be the
    headline of the exec summary.  When the leading sentence is mostly
    about a monitor-only label (case-insensitive substring match on the
    bare label, stripped of quotes/sentiment-bucket annotations), we drop
    that sentence.  If the result has no sentences left, return empty
    string so the placeholder path fires.
    """
    if not text or not monitor_topic_labels:
        return text
    # The monitor_topic_labels entries are formatted like "'Foo' (negative)";
    # strip to just the bare label text for matching.
    bare_labels: list[str] = []
    for entry in monitor_topic_labels:
        # Pull the part inside the leading single quotes if present.
        m = re.match(r"^['\"](.*?)['\"]", entry)
        if m:
            bare_labels.append(m.group(1).lower())
        else:
            bare_labels.append(entry.lower())
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    if not sentences:
        return text
    lead = sentences[0].lower()
    for label in bare_labels:
        if not label:
            continue
        # Two-condition match: label appears in the lead sentence AND the
        # lead sentence is short enough that the label is dominant (label
        # length / sentence length > 8%), to avoid stripping a long lead
        # that just incidentally mentions the label.
        if label in lead and (len(label) / max(len(lead), 1)) > 0.08:
            logger.warning(
                "Exec lead sentence dominated by monitor-only topic %r; dropping. lead=%s",
                label, sentences[0][:200],
            )
            remaining = sentences[1:]
            return " ".join(remaining)
    return text


def _call_exec(
    client,
    game_name,
    window_label,
    pos_str,
    neg_str,
    neu_str,
    total_posts,
    pos_count: int = 0,
    neg_count: int = 0,
    neu_count: int = 0,
    sample_posts: Optional[dict[str, list[str]]] = None,
    distinctive_entities: Optional[list[str]] = None,
    # CLAUDE.md §20 layers 3+4: citation grounding + self-criticism.
    annotated_samples: Optional[dict[str, list[dict]]] = None,
    citation_map: Optional[dict[str, dict]] = None,
    # CLAUDE.md §21: per-title commercial strategic context.
    commercial_context: Optional[str] = None,
    # CLAUDE.md §21b (2026-06-29 fix): the exec summary must respect the
    # same critical-mass gate as recommended actions — a single-post
    # "monitor-only" topic must NOT become the primary exec theme.
    critical_mass_table: Optional[dict[str, list[tuple[str, float, int, str]]]] = None,
    # §24e (2026-06-29): editorial articles contribute to the fabrication
    # whitelist so the sanitizer doesn't strip legitimate editorial nouns.
    editorial_articles: Optional[list] = None,
) -> str:
    # Bug 2 fix: compute breakdown strings and negative percentage so the
    # prompt can REQUIRE Claude to reference actual counts numerically.
    neg_pct = (neg_count / total_posts * 100) if total_posts > 0 else 0.0
    pos_pct = (pos_count / total_posts * 100) if total_posts > 0 else 0.0
    neu_pct = (neu_count / total_posts * 100) if total_posts > 0 else 0.0

    # Build the banned-phrase instruction only when negative is meaningful (>5%)
    if neg_pct > 5.0:
        banned_phrase_instruction = (
            f"BANNED PHRASES (do NOT use ANY of these when negative_pct > 5%): "
            f"\"no clear negative signals\", \"no friction points\", \"no negative signals\", "
            f"\"stable player satisfaction\", \"absence of friction\". "
            f"These are factually wrong given {neg_count} negative posts ({neg_pct:.1f}% of total).\n"
        )
    else:
        banned_phrase_instruction = ""

    sample_posts = sample_posts or {}
    distinctive_entities = distinctive_entities or []
    citation_map = citation_map or {}
    # Prefer citation-annotated samples block when we have one so the LLM
    # sees [P-NNN] tokens it can echo back; falls back to plain block.
    if annotated_samples and citation_map:
        samples_block = _format_sample_posts_block_with_citations(annotated_samples)
    else:
        samples_block = _format_sample_posts_block(sample_posts)
    entities_block = _format_entities_block(distinctive_entities)
    citation_clause = _citation_requirement_clause(citation_map)

    # Specifics-anchoring requirement: when we have either samples or entities,
    # the summary MUST name something specific.  This is the core of the
    # 2026-05-30 hardening pass — generic "sentiment is positive" prose is
    # banned when concrete material is available.
    has_specifics = bool(samples_block) or bool(entities_block)
    if has_specifics:
        specificity_requirement = (
            "SPECIFICITY REQUIREMENT (hard rule):\n"
            "- At least 2 of your 3-5 sentences MUST cite something specific from the SAMPLE POSTS "
            "or DISTINCTIVE ENTITIES below — a named feature, level, weapon, character, mode, patch "
            "number, update name, content drop, or event.\n"
            "- Use the actual name as it appears (don't paraphrase \"Tyranid Warrior\" as \"a tough enemy\").\n"
            "- Tie each specific to a sentiment direction supported by the data (e.g. \"Tyranid Warrior "
            "boss fight is the loudest negative thread\", or \"praise for the free Salamanders Chapter "
            "Pack drove most positive volume\").\n"
            "- If multiple specifics compete for attention, lead with the one mentioned in the most posts.\n"
            "- Do NOT invent specifics that aren't in the samples or entities list. Stick to what the data shows.\n\n"
        )
    else:
        specificity_requirement = (
            "NO SPECIFICS AVAILABLE: sample posts and distinctive entities are both empty.\n"
            "Write a short, honest paragraph noting the period saw mostly general discussion "
            "without a clear dominant event or topic. Keep it to 2-3 sentences.\n\n"
        )

    release_status = _infer_release_status(samples_block)
    release_clause = _release_status_clause(release_status)
    # CLAUDE.md §21: commercial strategic context + signal classification.
    commercial_clause = _commercial_context_clause(commercial_context)
    # CLAUDE.md §21b (2026-06-29): plumb critical-mass into the exec prompt so
    # the summary cannot lead with a monitor-only single-post theme.
    cm_block = _format_critical_mass_block(critical_mass_table or {})
    # Hard guard: enumerate theme-tier topics that ARE eligible to lead and
    # monitor-only topics that are NOT.  This is stronger than the table alone.
    theme_topics: list[str] = []
    monitor_topics: list[str] = []
    for sentiment_bucket in ("positive", "negative", "neutral"):
        for label, _weight, _days, tier in (critical_mass_table or {}).get(sentiment_bucket, []):
            if tier == "theme":
                theme_topics.append(f"{label!r} ({sentiment_bucket})")
            elif tier == "monitor-only":
                monitor_topics.append(f"{label!r} ({sentiment_bucket})")
    if theme_topics or monitor_topics:
        exec_cm_clause = (
            "EXEC LEADING-THEME GATE (HARD RULE, §21b):\n"
            "- Your first/lead sentence MUST describe a topic from the THEME-TIER "
            "list below (or note overall mixed/neutral sentiment if no theme "
            "exists).\n"
            "- You MAY NOT make a MONITOR-ONLY topic the lead, the headline "
            "liability, or the dominant framing.  Monitor-only topics are "
            "single-post or sub-threshold signal — mentioning them as the "
            "primary theme is a factual misrepresentation of the data.\n"
            "- A monitor-only topic MAY be referenced ONCE in a supporting "
            "sentence as 'worth watching' if relevant, but never as the "
            "headline.\n"
            f"  THEME-TIER (eligible to lead): {', '.join(theme_topics) if theme_topics else 'NONE — lead with overall mix instead'}\n"
            f"  MONITOR-ONLY (NOT eligible to lead): {', '.join(monitor_topics) if monitor_topics else 'none'}\n\n"
        )
    else:
        exec_cm_clause = ""

    prompt = (
        f'You are a game industry analyst writing for the leadership team about "{game_name}".\n\n'
        + _OUTPUT_STYLE +
        f"Write a TIGHT 3-5 sentence executive summary of community sentiment covering {window_label}.\n\n"
        + commercial_clause
        + _SIGNAL_CLASSIFICATION_CLAUSE
        + (cm_block + "\n" if cm_block else "")
        + exec_cm_clause
        + release_clause
        + citation_clause
        + specificity_requirement +
        f"Concision rules:\n"
        f"- 200 WORDS MAX. Aim for 140-170.\n"
        f"- Lead with the dominant signal in 1 sentence, then 2-4 sentences of supporting detail.\n"
        f"- Cite topic names and entity names exactly as provided.\n"
        f"- NO parenthetical lists of examples. NO 'this suggests... which means... and therefore...' chains.\n"
        f"- If post volume is low, say so plainly in 1 short sentence and keep the rest equally short.\n"
        f"- Your first sentence MUST reference the actual positive AND negative counts numerically "
        f"(e.g. '{pos_count} positive vs {neg_count} negative posts'). "
        f"Do NOT say 'no clear negative signals' if the negative count is greater than 5% of total.\n"
        + banned_phrase_instruction +
        f"\nData ({window_label}):\n"
        f"Positive: {pos_count} ({pos_pct:.1f}%)\n"
        f"Negative: {neg_count} ({neg_pct:.1f}%)\n"
        f"Neutral:  {neu_count} ({neu_pct:.1f}%)\n"
        f"Total posts analyzed: {total_posts}\n"
        f"Top positive topics: {pos_str}\n"
        f"Top negative topics: {neg_str}\n"
        f"Top neutral topics: {neu_str}\n\n"
    )

    if entities_block:
        prompt += f"DISTINCTIVE ENTITIES surfaced in this window (use as specific anchors):\n  {entities_block}\n\n"
    if samples_block:
        prompt += (
            "REPRESENTATIVE SAMPLE POSTS (top-upvoted in each sentiment, truncated):\n"
            f"{samples_block}\n\n"
        )
    prompt += "Write ONLY the summary paragraph. No bullet points, no headings, no preamble."

    exec_trace: dict = {"game_name": game_name, "total_posts": total_posts}
    try:
        message = client.messages.create(
            model=_MODEL,
            max_tokens=_MAX_TOKENS_SUMMARY,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text.strip()
        exec_trace["raw_llm_len"] = len(raw)
        exec_trace["raw_preview"] = raw[:500]
        # CLAUDE.md §20 layer 3: drop sentences that lack a valid [P-NNN]
        # citation when citation infra is active.
        before = len(raw)
        raw = _strip_uncited_sentences(raw, citation_map)
        exec_trace["after_strip_uncited_len"] = len(raw)
        exec_trace["lost_to_strip_uncited"] = before - len(raw)
        # CLAUDE.md §20 layer 4: second-pass self-criticism.  Skipped when
        # citation_map is empty (legacy callers).
        before = len(raw)
        raw = _self_criticize(client, raw, citation_map, "exec_summary")
        exec_trace["after_self_criticize_len"] = len(raw)
        exec_trace["lost_to_self_criticize"] = before - len(raw)
        # CLAUDE.md §22 (2026-06-29): re-scrub orphan discourse markers
        # AFTER all stripping passes — the critic can drop sentences too,
        # producing a new orphan opener that the layer-3 scrub didn't see.
        raw = _scrub_orphan_opener(raw)
        # CLAUDE.md §20 layer 2: post-LLM proper-noun fact-check gate.
        topic_labels = [pos_str or "", neg_str or "", neu_str or ""]
        before = len(raw)
        result = _sanitize_executive_summary(
            raw, game_name, sample_posts, distinctive_entities, topic_labels,
            editorial_articles=editorial_articles,
        )
        exec_trace["after_sanitize_len"] = len(result)
        exec_trace["lost_to_sanitize"] = before - len(result)
        # CLAUDE.md §21b (2026-06-29): post-LLM monitor-only lead detector.
        before = len(result)
        result = _strip_monitor_only_lead(result, monitor_topics)
        exec_trace["after_strip_monitor_lead_len"] = len(result)
        exec_trace["lost_to_strip_monitor_lead"] = before - len(result)
        # Final scrub after sanitizer too — belt-and-suspenders.
        result = _scrub_orphan_opener(result)
        exec_trace["after_final_scrub_len"] = len(result)
        # CLAUDE.md §21c/§22 (2026-06-29): if the post-strip result opens
        # with a mid-sentence fragment ("109 negative), players...") OR is
        # entirely empty, drop to the clean placeholder rather than ship
        # nonsense.
        is_frag = _looks_like_fragment_lead(result)
        exec_trace["is_fragment_lead"] = is_frag
        exec_trace["final_preview"] = result[:300]
        if not result.strip() or is_frag:
            logger.warning(
                "Exec summary produced fragmentary/empty result for '%s' (raw=%s); falling back to placeholder",
                game_name, result[:200],
            )
            exec_trace["placeholder_fired"] = True
            _record_exec_trace(exec_trace)
            return _placeholder_summary(
                game_name, window_label, total_posts,
                pos_str=pos_str, neg_str=neg_str,
                pos_count=pos_count, neg_count=neg_count, neu_count=neu_count,
            )
        exec_trace["placeholder_fired"] = False
        _record_exec_trace(exec_trace)
        return result
    except Exception as exc:
        logger.error("Claude exec summary error for '%s': %s", game_name, exc)
        exec_trace["error"] = str(exc)
        exec_trace["placeholder_fired"] = True
        _record_exec_trace(exec_trace)
        return _placeholder_summary(
            game_name, window_label, total_posts,
            pos_str=pos_str, neg_str=neg_str,
            pos_count=pos_count, neg_count=neg_count, neu_count=neu_count,
        )


def _safe_fetch_editorial(
    db,
    *,
    game_id: int,
    scope: str,
    cycle_start,
    cycle_end,
) -> list:
    """§24: thin wrapper around editorial_research_service.fetch_editorial_for_title
    that catches any failure (network, parse, LLM) and returns [] so the
    digest path continues even when editorial fetch fails entirely.

    Editorial is a NICE-TO-HAVE for bold ideas — a failure here must NOT
    block the rest of the digest.
    """
    try:
        from services.editorial_research_service import fetch_editorial_for_title
        client = _get_client()
        return fetch_editorial_for_title(
            db,
            game_id=game_id,
            scope=scope,
            cycle_start=cycle_start,
            cycle_end=cycle_end,
            anthropic_client=client,
        )
    except Exception as exc:
        logger.warning(
            "§24: editorial fetch failed (game_id=%d scope=%s); continuing without: %s",
            game_id, scope, exc,
        )
        return []


def _count_valid_recommendations(rec_actions: Optional[str]) -> int:
    """Count numbered items in rec_actions that pass the format contract.
    Returns 0 if rec_actions is None / empty / NONE-shaped.
    """
    if not rec_actions:
        return 0
    items = re.findall(r"^\s*\d+\.\s+.+$", rec_actions, re.MULTILINE)
    valid = 0
    for it in items:
        if not _item_has_substantive_content(it):
            continue
        if not _RECOMMENDATION_VERB_RE.match(it):
            continue
        if "**" not in it:
            continue
        valid += 1
    return valid


def _retry_actions_if_below_min(
    *,
    client,
    rec_actions: Optional[str],
    total_posts: int,
    game_name: str,
    window_label: str,
    pos_str: str,
    neg_str: str,
    neu_str: str,
    sample_posts: Optional[dict[str, list[str]]] = None,
    distinctive_entities: Optional[list[str]] = None,
    annotated_samples: Optional[dict[str, list[dict]]] = None,
    citation_map: Optional[dict[str, dict]] = None,
    commercial_context: Optional[str] = None,
    critical_mass_table: Optional[dict] = None,
    editorial_articles: Optional[list] = None,
) -> Optional[str]:
    """§22b: if `rec_actions` has fewer than _REC_COUNT_MIN valid items on a
    substantive title with at least one theme-tier topic, do ONE retry
    pass with an explicit fix-list hint injected at the top of the prompt.
    Otherwise return `rec_actions` unchanged.

    Bounded to a single retry to avoid runaway LLM call counts.
    """
    count = _count_valid_recommendations(rec_actions)
    if count >= _REC_COUNT_MIN:
        return rec_actions
    if total_posts < _MIN_SUBSTANTIVE_POSTS:
        return rec_actions
    # §24e (2026-06-29): the prior version of this gate also required at
    # least one 'theme'-tier topic in the critical-mass table.  That gate
    # was too strict — high-volume titles whose discussion is spread thinly
    # across many narrow topics (Space Marine 2 with 968 posts and the
    # top topic only appearing on 1-2 days) never hit theme tier and so
    # never got the retry, leaving them with 1 rec.
    # POSITIVE amplifications anchored on real entities are valid even
    # with no negative theme — the retry-pass prompt makes that explicit.
    # We now retry on EVERY substantive title that fails the min count.
    cm = critical_mass_table or {}
    has_theme = any(
        t for bucket in cm.values() for t in (bucket or [])
        if len(t) >= 4 and t[3] == "theme"
    )
    logger.warning(
        "§22b/§24e: rec_actions has only %d valid items on substantive title '%s' "
        "(total_posts=%d, themes_available=%s); running ONE retry pass",
        count, game_name, total_posts, has_theme,
    )
    hint = (
        f"Your previous response produced {count} valid recommendation(s) for "
        f"a title with {total_posts} substantive community posts and "
        f"theme-tier topics available.  The minimum target is "
        f"{_REC_COUNT_MIN}-{_REC_COUNT_MAX}."
    )
    retried = _call_actions(
        client, game_name, window_label, pos_str, neg_str, neu_str,
        sample_posts=sample_posts,
        distinctive_entities=distinctive_entities,
        annotated_samples=annotated_samples,
        citation_map=citation_map,
        commercial_context=commercial_context,
        critical_mass_table=critical_mass_table,
        retry_fix_list_hint=hint,
        editorial_articles=editorial_articles,
    )
    retried_count = _count_valid_recommendations(retried)
    if retried_count >= count:
        logger.warning(
            "§22b: retry succeeded for '%s' (was %d, now %d)",
            game_name, count, retried_count,
        )
        return retried
    logger.warning(
        "§22b: retry produced FEWER items for '%s' (was %d, retry %d); "
        "keeping original output", game_name, count, retried_count,
    )
    return rec_actions


def _call_actions(
    client,
    game_name,
    window_label,
    pos_str,
    neg_str,
    neu_str,
    sample_posts: Optional[dict[str, list[str]]] = None,
    distinctive_entities: Optional[list[str]] = None,
    annotated_samples: Optional[dict[str, list[dict]]] = None,
    citation_map: Optional[dict[str, dict]] = None,
    commercial_context: Optional[str] = None,
    # CLAUDE.md §21b: per-topic critical-mass tiers.
    critical_mass_table: Optional[dict[str, list[tuple[str, float, int, str]]]] = None,
    # CLAUDE.md §22b (2026-06-29): low-rec-count retry support.
    retry_fix_list_hint: Optional[str] = None,
    # §24e (2026-06-29): editorial articles contribute to fab whitelist.
    editorial_articles: Optional[list] = None,
) -> str:
    sample_posts = sample_posts or {}
    distinctive_entities = distinctive_entities or []
    citation_map = citation_map or {}
    if annotated_samples and citation_map:
        samples_block = _format_sample_posts_block_with_citations(annotated_samples)
    else:
        samples_block = _format_sample_posts_block(sample_posts)
    entities_block = _format_entities_block(distinctive_entities)
    citation_clause = _citation_requirement_clause(citation_map)

    # When we have specifics, recommendations should bold a SPECIFIC entity
    # name (e.g. **Salamanders Chapter Pack**) rather than a generic topic
    # bucket like **Combat Mechanics** — the latter doesn't tell a PM what to
    # actually do.
    if entities_block or samples_block:
        specificity_clause = (
            "PREFERENCE: when a distinctive entity (named DLC, level, weapon, character, "
            "patch number, mode, etc.) is available, bold THAT NAME instead of a generic "
            "topic label. Specifics > buckets. Pick the entity that has the strongest "
            "sentiment signal in the samples.\n\n"
        )
    else:
        specificity_clause = ""
    anti_fab = _anti_fabrication_clause(samples_block, entities_block)

    release_status = _infer_release_status(samples_block)
    release_clause = _release_status_clause(release_status)
    # CLAUDE.md §21: commercial strategic context + signal classification.
    commercial_clause = _commercial_context_clause(commercial_context)
    # CLAUDE.md §21b: recommendation-class critical mass.
    cm_block = _format_critical_mass_block(critical_mass_table or {})

    # The default verb suggestion list shifts based on whether the game is live.
    # 2026-06-29: removed 'Counter-position' from the pre-release list — it
    # was biasing the LLM to recommend distancing from positive commercial
    # comparisons.  'Counter-position' is reserved for differentiating from a
    # named THREAT, not for deflecting a positive comparison.
    if release_status == "pre-release":
        verb_examples = (
            "Lean into, Amplify, Double down on, Anchor on, Spotlight, Embrace, "
            "Clarify, Communicate, Reframe, Address, Document, Publish, Reveal, "
            "Showcase, Reassure"
        )
    else:
        verb_examples = (
            "Lean into, Amplify, Double down on, Anchor on, Spotlight, "
            "Ship, Patch, Audit, Launch, Clarify, Document, Sunset"
        )

    # §22b: a retry pass injects an explicit fix-list at the very top of
    # the prompt naming the specific defect.  Empty on first-pass calls.
    retry_clause = ""
    if retry_fix_list_hint:
        retry_clause = (
            "!!! THIS IS A RETRY PASS — PREVIOUS OUTPUT WAS INSUFFICIENT !!!\n"
            f"{retry_fix_list_hint}\n\n"
            "Your previous response did not meet the minimum recommendation "
            "count for a title with this much signal.  Carefully re-read "
            "the sample posts and distinctive entities below, then produce "
            f"{_REC_COUNT_MIN}-{_REC_COUNT_MAX} grounded recommendations.  "
            "AMPLIFICATION recommendations anchored on real positive signals "
            "(named talent, organic comparisons, press coverage, community "
            "events) are ALWAYS valid even when no negative topic reaches "
            "theme tier — do not refuse on critical-mass grounds.\n\n"
        )
    prompt = (
        retry_clause +
        f'You are a game community manager and product strategist for "{game_name}".\n\n'
        + _OUTPUT_STYLE +
        anti_fab +
        commercial_clause +
        _SIGNAL_CLASSIFICATION_CLAUSE +
        (cm_block + "\n" if cm_block else "") +
        release_clause +
        citation_clause +
        f"Write 3-5 sprint-board-ready recommendations covering the breadth of signal in the data (target 3 minimum, 5 maximum). Each one MUST follow this format strictly:\n\n"
        f"  <Imperative verb> **<exact specific entity OR topic label>** — <what to do, in <=25 words>.\n\n"
        + specificity_clause +
        f"Hard concision rules:\n"
        f"- 35 WORDS MAX per recommendation. Aim for 22-30.\n"
        f"- Start with an imperative verb ({verb_examples}).\n"
        f"- Bold the entity or label exactly as provided, using **double asterisks**.\n"
        f"- NO parenthetical examples, NO 'this is your clearest signal' framing, NO 'should anchor messaging through next quarter' filler.\n"
        f"- ONE sentence per recommendation. No semicolons. No 'and... and...' chains. If you need two ideas, write two recommendations.\n\n"
        f"Good example (specific entity, named):\n"
        f"  1. Patch **Tyranid Warrior** boss fight — ammo and health scarcity flagged across multiple negative posts.\n"
        f"  2. Amplify **Salamanders Chapter Pack** — free DLC drop driving most positive volume this week.\n\n"
        f"Bad example (too generic, no entity):\n"
        f"  1. Lean into **Combat Mechanics** momentum by shipping comparative feature breakdowns…\n\n"
        f"The §21b critical-mass gate applies to LIABILITY recommendations only.  POSITIVE "
        f"amplifications (Lean into, Amplify, Double down on, Spotlight, Embrace) anchored on "
        f"real cited entities are always allowed even when no negative topic reaches theme tier.\n\n"
        f"If you genuinely cannot produce 3+ actionable recommendations from the available topics, "
        f"respond with the SINGLE LINE: NONE — nothing else, no explanation.\n\n"
        f"Data ({window_label}):\n"
        f"Negative topics: {neg_str}\n"
        f"Neutral topics: {neu_str}\n"
        f"Positive topics: {pos_str}\n\n"
    )

    if entities_block:
        prompt += f"DISTINCTIVE ENTITIES surfaced in this window:\n  {entities_block}\n\n"
    if samples_block:
        prompt += f"REPRESENTATIVE SAMPLE POSTS:\n{samples_block}\n\n"
    prompt += "Output: numbered list (1. ... 2. ... 3. ...). Plain prose, no markdown headings."

    recs_trace: dict = {
        "game_name": game_name,
        "is_retry": bool(retry_fix_list_hint),
    }
    try:
        message = client.messages.create(
            model=_MODEL,
            max_tokens=_MAX_TOKENS_ACTIONS,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text.strip()
        recs_trace["raw_llm_len"] = len(raw)
        recs_trace["raw_preview"] = raw[:500]
        # §20 layer 3: drop uncited items BEFORE structural parsing
        before = raw.count("\n")
        raw = _strip_uncited_items(raw, citation_map)
        recs_trace["after_strip_uncited_lines"] = raw.count("\n")
        # §20 layer 4: self-criticism on items.
        raw = _self_criticize_items(client, raw, citation_map, "recommendations")
        recs_trace["after_self_criticize_lines"] = raw.count("\n")
        parsed = _parse_recommended_actions(raw)
        if parsed is None:
            recs_trace["after_parse"] = None
            _record_recs_trace(recs_trace)
            return parsed
        recs_trace["after_parse"] = parsed.count("\n") + 1 if parsed else 0
        # §20 layer 2: proper-noun fact-check.
        topic_labels = [pos_str or "", neg_str or "", neu_str or ""]
        sanitized = _sanitize_recommendations(
            parsed, game_name, sample_posts, distinctive_entities, topic_labels,
            editorial_articles=editorial_articles,
        )
        recs_trace["after_sanitize"] = sanitized.count("\n") + 1 if sanitized else 0
        # §20 layer 2b: release-status gate.
        if sanitized:
            sanitized = _sanitize_recommendations_for_release_status(
                sanitized, release_status,
            )
        recs_trace["after_release_gate"] = sanitized.count("\n") + 1 if sanitized else 0
        final_count = _count_valid_recommendations(sanitized)
        recs_trace["final_valid_count"] = final_count
        recs_trace["final_preview"] = (sanitized or "")[:500]
        _record_recs_trace(recs_trace)
        return sanitized or None
    except Exception as exc:
        logger.error("Claude actions error for '%s': %s", game_name, exc)
        return _placeholder_actions()


def _call_bold_ideas(
    client,
    game_name,
    window_label,
    pos_str,
    neg_str,
    neu_str,
    total_posts,
    sample_posts: Optional[dict[str, list[str]]] = None,
    distinctive_entities: Optional[list[str]] = None,
    annotated_samples: Optional[dict[str, list[dict]]] = None,
    citation_map: Optional[dict[str, dict]] = None,
    commercial_context: Optional[str] = None,
    # CLAUDE.md §21b: per-topic critical-mass tiers.
    critical_mass_table: Optional[dict[str, list[tuple[str, float, int, str]]]] = None,
    # CLAUDE.md §24 (2026-06-29): hybrid editorial citations.
    editorial_articles: Optional[list] = None,
    demographic_context: Optional[str] = None,
) -> list[str]:
    sample_posts = sample_posts or {}
    distinctive_entities = distinctive_entities or []
    citation_map = dict(citation_map or {})
    if annotated_samples and citation_map:
        samples_block = _format_sample_posts_block_with_citations(annotated_samples)
    else:
        samples_block = _format_sample_posts_block(sample_posts)
    entities_block = _format_entities_block(distinctive_entities)
    anti_fab = _anti_fabrication_clause(samples_block, entities_block)

    # §24 (2026-06-29): merge editorial articles into the citation map and
    # build a SOURCE EDITORIAL block for the prompt.  When present, the
    # bold-ideas LLM is allowed to anchor ideas on either [P-NNN] (post)
    # or [E-NNN] (editorial) citations — the hybrid rule.
    editorial_block = ""
    if editorial_articles:
        try:
            from services.editorial_research_service import (
                format_editorial_for_prompt,
                editorial_citation_map,
            )
            editorial_block = format_editorial_for_prompt(editorial_articles)
            editorial_cmap = editorial_citation_map(editorial_articles)
            # Merge into the existing citation_map so downstream gates
            # accept E-NNN citations alongside P-NNN.
            citation_map.update(editorial_cmap)
        except Exception as exc:
            logger.warning(
                "§24: editorial integration failed for '%s': %s",
                game_name, exc,
            )
            editorial_block = ""

    citation_clause = _citation_requirement_clause(citation_map)

    release_status = _infer_release_status(samples_block)
    release_clause = _release_status_clause(release_status)
    # CLAUDE.md §21: commercial strategic context + signal classification.
    commercial_clause = _commercial_context_clause(commercial_context)
    # CLAUDE.md §21b: recommendation-class critical mass.
    cm_block = _format_critical_mass_block(critical_mass_table or {})
    # §24: demographic-context brief, when configured per-title.
    demographic_clause = ""
    if demographic_context:
        demographic_clause = (
            "PER-TITLE DEMOGRAPHIC + IP-AWARENESS BRIEF (§24):\n"
            f"{demographic_context.strip()}\n\n"
            "Use this brief to ground SPECULATIVE bold ideas about cohort "
            "reach.  Speculative reasoning about target demographics is "
            "allowed when the idea is anchored on either a [P-NNN] post "
            "OR an [E-NNN] editorial citation that supports the underlying "
            "signal.  The brief itself is NOT a citation — it's context.\n\n"
        )

    # §24 hybrid-citation framing: when editorial is present, the prompt
    # opens up to speculative cohort-reach reasoning; when editorial is
    # absent, the prompt falls back to the strict §20 anchor-in-posts rule.
    bold_ideas_anchor_clause = (
        f"Propose 2 bold ideas that go BEYOND the obvious fixes already in the recommended actions. "
        f"The bold move should reference a SPECIFIC entity from the data below — not a generic bucket.\n\n"
        f"BOLD IDEAS ARE STRATEGIC OR CREATIVE MOVES — NOT BUG FIXES OR LIABILITY RESPONSES.\n"
        f"  WRONG: 'Patch the black-screen post-match bug' (that's a recommended action).\n"
        f"  WRONG: 'Address weapon balance complaints' (that's a recommended action).\n"
        f"  RIGHT: 'Spotlight Gunship's analog glitch aesthetic as the synth differentiator' (creative positioning).\n"
        f"  RIGHT: 'Launch a Doug Bradley interview circuit targeting the under-35 horror discovery cohort' (audience reach).\n"
        f"  RIGHT: 'Lean into the Resident Evil comparison as validation of single-player survival horror' (positioning vs comp).\n"
        f"Bold ideas should propose: amplifying named talent, partnership angles, community events, "
        f"unexpected creative content (videos, retrospectives, devlogs), cohort-reach plays, positioning "
        f"vs comparable titles, IP-deepening moves.\n\n"

    )
    if editorial_articles:
        bold_ideas_anchor_clause += (
            "§24c HYBRID + GROUNDED CITATION (READ CAREFULLY):\n"
            "Each bold idea MUST satisfy BOTH of the following:\n"
            "  (1) THEMATIC ANCHOR — it must connect to a SPECIFIC topic / "
            "entity / sentiment pattern that appears in the in-window "
            "community sample posts below (cite at least one [P-NNN]).\n"
            "  (2) EDITORIAL CONTEXT — it must reference at least one "
            "[E-NNN] editorial article that supplies the WIDER context "
            "(industry comparable, launch playbook, IP positioning, "
            "demographic dynamic) the community post alone does NOT show.\n\n"
            "The bold idea is the BRIDGE: it uses the editorial signal to "
            "propose an action that addresses what the community is already "
            "talking about.  Editorial-only ideas with no post tie-in are "
            "REJECTED.  Post-only ideas duplicate the recommended actions; "
            "avoid them.  The whole point of §24 is to combine the two.\n\n"
            "Format your citations as [P-NNN, E-NNN] (both in one bracket) "
            "or as two separate brackets [P-NNN] [E-NNN] at the end of the "
            "sentence.  Both styles parse identically.\n\n"
            "SPECULATIVE REASONING IS ALLOWED — e.g. 'reach the <40 cohort "
            "that knows Pinhead imagery but not the franchise' — as long as "
            "the speculation is anchored on at least one post AND at least "
            "one editorial article whose body content supports it.\n\n"
            "GOOD example (both citations + bridge):\n"
            "  Lean into **Resident Evil 4** comparison — community framings "
            "already place Hellraiser alongside RE [P-007]; recent press "
            "coverage profiles the Barker auteur vision [E-002], a hook to "
            "differentiate vs generic survival horror.\n\n"
            "BAD example (editorial-only — REJECTED):\n"
            "  Launch a Pinhead retrospective inspired by the recent IGN "
            "feature [E-001]. (No post anchor — community may not actually "
            "be discussing retrospectives.)\n\n"
        )
    else:
        bold_ideas_anchor_clause += (
            "REMINDER: only entities that appear verbatim in the data below are valid bold-move anchors. "
            "Background knowledge about the franchise (prior actors, movies, lore) does not count.\n\n"
        )

    prompt = (
        f'You are a creative game marketing strategist for "{game_name}". '
        f"Looking at community signals from {window_label}, find opportunities a typical analyst would MISS.\n\n"
        + _OUTPUT_STYLE +
        anti_fab +
        commercial_clause +
        demographic_clause +
        _SIGNAL_CLASSIFICATION_CLAUSE +
        (cm_block + "\n" if cm_block else "") +
        release_clause +
        citation_clause +
        bold_ideas_anchor_clause +
        f"Concision rules:\n"
        f"- 40 WORDS MAX per idea. Aim for 25-30.\n"
        f"- One sentence stating the bold move, optionally one second sentence on why.\n"
        f"- Bold the referenced entity or label exactly as it appears, using **double asterisks**.\n"
        f"- Be surprising or non-obvious (community event, partnership angle, unexpected creative response).\n"
        f"- NO 'this is your X' framing. NO 'compounds loyalty' or 'lock in goodwill' filler.\n"
        + (
            f"- Cite at least one [P-NNN] post (thematic anchor) AND at least one [E-NNN] editorial article (wider context). Both required when editorial is available.\n\n"
            if editorial_articles else
            f"- Cite the [P-NNN] post that supports the idea.\n\n"
        )
        +
        f"The §21b critical-mass gate applies to LIABILITY recommendations only.  Bold ideas that "
        f"AMPLIFY a positive signal (talent involvement, press coverage, organic genre comparisons, "
        f"community events) are always allowed even when no negative topic reaches theme tier.\n\n"
        f"If — after honestly reviewing the data — nothing supports a bold idea, respond with the "
        f"SINGLE LINE: NONE.\n"
        f"BUT: when sample posts AND distinctive entities are both present, you should usually find "
        f"1-2 real opportunities.  Return NONE only when the data truly shows no actionable signal "
        f"beyond the obvious fixes already covered by the recommended actions.\n\n"
        f"Data ({window_label}):\n"
        f"Positive topics: {pos_str}\n"
        f"Negative topics: {neg_str}\n"
        f"Neutral topics: {neu_str}\n"
        f"Total posts: {total_posts}\n\n"
    )

    if entities_block:
        prompt += f"DISTINCTIVE ENTITIES:\n  {entities_block}\n\n"
    if samples_block:
        prompt += f"REPRESENTATIVE SAMPLE POSTS:\n{samples_block}\n\n"
    if editorial_block:
        prompt += f"{editorial_block}\n\n"

    # §24: example shape changes when editorial is present — the citation
    # placeholder shows the hybrid choice.
    citation_placeholder = (
        "[P-NNN, E-NNN]" if editorial_articles else "[P-NNN]"
    )
    prompt += (
        f"OUTPUT FORMAT (MANDATORY — read carefully):\n"
        f"Your response MUST be ONE of these two shapes, and NOTHING ELSE:\n\n"
        f"  SHAPE A (2 bold ideas — produce 2 whenever data supports it):\n"
        f"  1. <Imperative-verb opener> **specific entity** — <rationale, 25-40 words>. {citation_placeholder}\n"
        f"  2. <Optional second, same shape>\n\n"
        f"  SHAPE B (no actionable bold idea found):\n"
        f"  NONE\n\n"
        f"HARD PROHIBITIONS — do NOT emit any of the following:\n"
        f"  • NO '# EXECUTIVE SUMMARY', '## Analysis', '## Key Observation', or any markdown headings.\n"
        f"  • NO '**Key Signal:**' or '**Observation:**' framing lines.\n"
        f"  • NO preamble paragraphs describing the data before the numbered list.\n"
        f"  • NO trailing commentary or analysis after the numbered list.\n"
        f"  • Each numbered item MUST start with an imperative verb (Amplify, Lean into, "
        f"Spotlight, Partner with, Launch, Host, Sponsor, Address, etc.) OR a bolded entity "
        f"with the imperative verb in the same sentence.\n\n"
        f"If your first instinct is to write an exec-summary preamble: don't. Skip directly to '1. <Verb>'."
    )

    trace: dict = {"game_name": game_name}
    try:
        message = client.messages.create(
            model=_MODEL,
            max_tokens=_MAX_TOKENS_BOLD,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text.strip()
        trace["raw_llm_len"] = len(raw)
        trace["raw_preview"] = raw[:500]
        parsed = _parse_bold_ideas(raw)
        trace["after_parse"] = len(parsed)
        trace["after_parse_preview"] = [p[:200] for p in parsed]
        # CLAUDE.md §20 layer 3: drop uncited bold ideas.
        before = len(parsed)
        parsed = _strip_uncited_bold_ideas(parsed, citation_map)
        trace["after_strip_uncited"] = len(parsed)
        trace["lost_to_strip_uncited"] = before - len(parsed)
        # CLAUDE.md §20 layer 4: self-criticism on each idea.
        before = len(parsed)
        parsed = _self_criticize_bold_ideas(client, parsed, citation_map)
        trace["after_self_criticize"] = len(parsed)
        trace["lost_to_self_criticize"] = before - len(parsed)
        # CLAUDE.md §20 layer 2: proper-noun fact-check.
        before = len(parsed)
        topic_labels = [pos_str or "", neg_str or "", neu_str or ""]
        parsed = _sanitize_bold_ideas(
            parsed, game_name, sample_posts, distinctive_entities, topic_labels,
            editorial_articles=editorial_articles,
        )
        trace["after_sanitize"] = len(parsed)
        trace["lost_to_sanitize"] = before - len(parsed)
        # CLAUDE.md §20 layer 5: orphan-reference guard.
        before = len(parsed)
        parsed = _strip_orphan_reference_ideas(parsed)
        trace["after_strip_orphan"] = len(parsed)
        trace["lost_to_strip_orphan"] = before - len(parsed)
        # CLAUDE.md §24c layer 6: editorial grounding gate.
        before = len(parsed)
        parsed = _enforce_editorial_grounding(
            parsed, citation_map,
            editorial_available=bool(editorial_articles),
        )
        trace["after_grounding"] = len(parsed)
        trace["lost_to_grounding"] = before - len(parsed)
        trace["final"] = len(parsed)
        _record_bold_trace(trace)
        return parsed
    except Exception as exc:
        logger.error("Claude bold ideas error for '%s': %s", game_name, exc)
        trace["error"] = str(exc)
        _record_bold_trace(trace)
        return []


# ── Output parsers ─────────────────────────────────────────────────────────────────────────

# Phrases that indicate the LLM is breaking the analyst voice with a meta-
# explanation of why it cannot do something. Any line/idea containing one of
# these is dropped from parsed output.
#
# We deliberately use non-word-boundary anchors so that markdown decoration
# like "**Reason:**" still matches. Each pattern is tested as a substring
# against the lowercased text.
_META_LEAK_PHRASES = (
    "i cannot",
    "i'm instructed",
    "i am instructed",
    "the rules say",
    "the rule says",
    "insufficient data to provide",
    "based on the constraints",
    "based on the rules",
    "reason:",
    "what would help:",
    "forbidden by rule",
    "business model concept i'm",
    "per the rules",
    "per the guidelines",
    "per the instructions",
    "i don't have enough",
    "i lack sufficient",
    "i'm not able to",
    "unable to provide",
    "cannot provide actionable",
    "cannot generate",
    "rule 1", "rule 2", "rule 3", "rule 4", "rule 5",
)

# A bold idea must look like substantive prose. Drop anything that's a markdown
# heading, bullet decoration, or too short to be a real idea.
_MARKDOWN_HEADING_OR_DECORATION = re.compile(r"^\s*(#{1,6}\s|[-*•]\s*$|\*{1,3}\s*$)")


def _looks_like_meta_leak(text: str) -> bool:
    """True if the text contains an analyst-voice-breaking meta-explanation.

    Substring match against a lowercased copy of the text so markdown decoration
    like "**Reason:**" and bullet prefixes don't hide the leak.
    """
    if not text:
        return False
    lower = text.lower()
    return any(phrase in lower for phrase in _META_LEAK_PHRASES)


def _is_markdown_heading_or_too_short(text: str) -> bool:
    """True if the text is a markdown heading or too short to be a real item.

    Filters out things like "# Analysis", "## Key Observation", or short stubs
    that result from accidentally splitting a structured response into items.
    """
    stripped = (text or "").strip()
    if not stripped:
        return True
    if _MARKDOWN_HEADING_OR_DECORATION.match(stripped):
        return True
    # Strip leading markdown bullet/heading characters to assess real length
    plain = re.sub(r"^[#*\-•\s]+", "", stripped)
    if len(plain) < 30:
        return True
    return False


def _parse_bold_ideas(raw: str) -> list[str]:
    """
    Parse Claude's bold ideas response.

    Returns [] when:
      - response is "NONE" (case-insensitive, trimmed),
      - all extracted candidate items are filtered out by quality checks.

    Parses numbered list ("1. ...\n2. ...") into list[str], then drops:
      - markdown headings or bullet decoration ("# Analysis", "## Key Observation")
      - items shorter than 30 chars (likely stub headers)
      - items containing meta-leak phrases ("I cannot", "the rules say", etc.)
    """
    if not raw or raw.strip().upper().startswith("NONE"):
        return []

    candidates: list[str] = []
    # Try numbered list pattern first
    items = re.findall(r"^\d+\.\s+(.+?)(?=\n\d+\.|\Z)", raw, re.MULTILINE | re.DOTALL)
    if items:
        candidates = [item.strip() for item in items]
    else:
        # Fallback: split on newlines
        for line in raw.splitlines():
            line = re.sub(r"^\d+\.\s*", "", line.strip())
            if line:
                candidates.append(line)

    # Quality filter: drop headings, stubs, and meta-leak items
    cleaned: list[str] = []
    for c in candidates:
        if _is_markdown_heading_or_too_short(c):
            logger.info("Bold idea dropped (heading/too short): %r", c[:80])
            continue
        if _looks_like_meta_leak(c):
            logger.info("Bold idea dropped (meta-leak): %r", c[:80])
            continue
        # 2026-06-29 (§21g): drop preamble candidates that bled in when the
        # LLM produced an exec block + 'Key Signal:' framing before the
        # numbered list.  A real bold idea opens with an imperative verb
        # OR a bolded entity followed by an imperative verb in the first
        # sentence.
        if not _bold_idea_has_imperative(c):
            logger.info(
                "Bold idea dropped (no imperative verb in first sentence): %r",
                c[:120],
            )
            continue
        cleaned.append(c)

    return cleaned


# 2026-06-29 (§21g): bold-idea candidates must open with an imperative verb
# from the strategic-marketing vocabulary.  Anything else — exec prose,
# 'Key Signal:' framing, 'The community is...', 'Post [P-NNN]...' — is
# preamble that bled into the parsed list and should be dropped before the
# critic runs.  Verbs are intentionally broad (covers amplify-class +
# partnership + content + investigation + launch verbs).
_BOLD_IDEA_IMPERATIVE_VERBS = (
    r"lean\s+into|amplify|double\s+down|anchor|spotlight|embrace|"
    r"capitalize|leverage|harness|elevate|champion|highlight|emphasize|"
    r"partner|collaborate|co-create|sponsor|host|launch|run|organize|"
    r"feature|promote|distribute|seed|cultivate|grow|recruit|invite|"
    r"create|build|design|produce|publish|release|reveal|drop|ship|"
    r"clarify|communicate|document|showcase|reassure|announce|share|"
    r"update|explain|confirm|acknowledge|respond|reframe|reposition|"
    r"audit|investigate|review|analyze|measure|benchmark|track|monitor|"
    r"surface|expose|probe|examine|profile|diagnose|test|experiment|"
    r"pilot|prototype|trial|invest|expand|sunset|deploy|roll\s*out|"
    r"pivot|tie|connect|bridge|introduce|kick\s*off|stand\s*up|"
    r"address|patch|hotfix|rebalance|nerf|buff|resolve|prioritize|"
    r"improve|optimize|tune|stabilize|polish|refine|fix|repair|"
    r"position|reposition|formalize|capitalise|recognise|recognize|"
    r"convert|migrate|seed|nurture|onboard"
)
_BOLD_IDEA_IMPERATIVE_RE = re.compile(
    r"^(?:" + _BOLD_IDEA_IMPERATIVE_VERBS + r")\b",
    re.IGNORECASE,
)
# 2026-06-29 (§21g): also accept candidates that open with a bolded entity
# but include an imperative verb LATER in the first sentence.  Example from
# live trace: "1. **Black Templars** faction community is self-organizing
# around immersion and brotherhood [P-021]. Spotlight this organic..."  --
# the imperative "Spotlight" comes after a subject-first clause but the
# idea is still a valid bold-idea opener.
_BOLD_IDEA_INLINE_VERB_RE = re.compile(
    r"\b(?:" + _BOLD_IDEA_IMPERATIVE_VERBS + r")\b",
    re.IGNORECASE,
)


def _bold_idea_has_imperative(candidate: str) -> bool:
    """True if `candidate` opens with (or contains in its first sentence)
    an imperative verb appropriate to a bold idea.  Tolerates leading
    markdown decoration, numbering, and bolded-entity subject openers.
    """
    if not candidate:
        return False
    # Strip leading markdown decoration (#, *, -, bullets, whitespace).
    s = re.sub(r"^[\s*#\-•]+", "", candidate).strip()
    # Strip leading numbering (e.g. '1. ' or '2) ').
    s = re.sub(r"^\d+[\.\)]\s*", "", s).strip()
    # Strip leading bold marker (e.g. '**Amplify ...' or '**Black Templars** ...').
    s = re.sub(r"^\*+\s*", "", s).strip()
    # Case 1: opens directly with an imperative verb.
    if _BOLD_IDEA_IMPERATIVE_RE.match(s):
        return True
    # Case 2: opens with a bolded entity (subject-first), but the first
    # sentence still contains an imperative verb later.
    first_sentence = re.split(r"(?<=[.!?])\s+", s, maxsplit=1)[0]
    if _BOLD_IDEA_INLINE_VERB_RE.search(first_sentence):
        return True
    return False


def _parse_recommended_actions(raw: str) -> Optional[str]:
    """
    Parse Claude's recommended-actions response.

    Returns None when:
      - response is "NONE" (case-insensitive, trimmed),
      - after filtering meta-leak content, nothing actionable remains.

    Otherwise returns the cleaned actions string (markdown-friendly).
    Meta-leak sentences ("I cannot provide actionable...", "Reason: ...",
    "What would help: ...") are stripped from the body. If stripping leaves
    the body too short to be useful, the whole thing collapses to None.
    """
    if not raw:
        return None
    stripped_full = raw.strip()
    if stripped_full.upper().startswith("NONE"):
        return None

    # Split into lines/paragraphs and filter out meta-leak lines
    out_lines: list[str] = []
    for line in stripped_full.splitlines():
        # Drop a line entirely if it is meta-leak. We are deliberately
        # aggressive here — the cost of dropping a borderline line is low,
        # the cost of leaving the user staring at "I cannot recommend" is high.
        if _looks_like_meta_leak(line):
            logger.info("Recommendation line dropped (meta-leak): %r", line[:80])
            continue
        out_lines.append(line)

    cleaned = "\n".join(out_lines).strip()

    # If the cleanup left us with effectively nothing (just a numbered-list
    # scaffold, or fewer than ~40 chars of substantive content), return None
    # so the frontend hides the section entirely instead of showing a stub.
    plain = re.sub(r"[\s\d.\-*#]+", " ", cleaned).strip()
    if len(plain) < 40:
        logger.info("Recommended actions collapsed to None after meta-leak filter")
        return None

    return cleaned


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

def _placeholder_summary(
    game_name: str,
    window_label: str,
    total_posts: int,
    pos_str: str = "",
    neg_str: str = "",
    pos_count: int = 0,
    neg_count: int = 0,
    neu_count: int = 0,
) -> str:
    """Honest low-signal fallback when the LLM result was discarded or empty.

    §24e (2026-06-29): when the sanitizer cuts a real LLM exec to a
    fragment, the placeholder used to render as 'community sentiment ...
    was mixed without a single dominant theme reaching critical mass'.
    That is misleading on high-volume titles where there ARE dominant
    topics; the LLM just produced an output the gates rejected.  When
    pos_str / neg_str are provided, the placeholder now grounds itself
    on the top topics + counts so the analyst still sees specifics.
    """
    if total_posts < _MIN_SUBSTANTIVE_POSTS:
        return (
            f"Insufficient signal for confident reporting "
            f"(only {total_posts} substantive posts in this window)."
        )
    # §24e: build a grounded fallback when we have topic data.
    if pos_str or neg_str:
        pos_lead = pos_str.split(",")[0].strip() if pos_str else ""
        neg_lead = neg_str.split(",")[0].strip() if neg_str else ""
        parts: list[str] = []
        parts.append(
            f"Community discussion across {total_posts} posts during "
            f"{window_label} produced {pos_count} positive, {neg_count} "
            f"negative, and {neu_count} neutral signals."
        )
        if pos_lead and neg_lead:
            parts.append(
                f"Top positive topic: {pos_lead}.  Top negative concern: "
                f"{neg_lead}.  Review the topic breakdowns and recommended "
                f"actions below for grounded detail."
            )
        elif pos_lead:
            parts.append(
                f"Top positive topic: {pos_lead}.  Review the topic "
                f"breakdowns and recommended actions below for detail."
            )
        elif neg_lead:
            parts.append(
                f"Top negative concern: {neg_lead}.  Review the topic "
                f"breakdowns and recommended actions below for detail."
            )
        return " ".join(parts)
    return (
        f"Community sentiment across {total_posts} posts during {window_label} "
        f"was mixed without a single dominant theme reaching critical mass. "
        f"See topic breakdowns below for grounded detail by sentiment bucket."
    )


def _placeholder_actions() -> str:
    return (
        "1. [AI actions unavailable — configure ANTHROPIC_API_KEY to enable.]\n"
        "2. Review negative topics manually and prioritise high-velocity issues.\n"
        "3. Amplify positive community feedback through official channels."
    )
