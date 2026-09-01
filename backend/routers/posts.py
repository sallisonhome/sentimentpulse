"""
Posts router — GET /api/games/{game_id}/posts

Paginated raw-post browser with filters for sentiment, source, and date range.
Sentiment records are loaded via an outer join so unclassified posts are still
returned (sentiment_info will be null for them).
"""
import math
import logging
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, contains_eager

from database import get_db
from models import Game, RawPost, SentimentEnum, SentimentRecord, SourceEnum
from schemas import PostSentimentInfo, PostsPageResponse, RawPostResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/games", tags=["posts"])


@router.get("/{game_id}/posts", response_model=PostsPageResponse)
def get_posts(
    game_id: int,
    # Filters
    sentiment: Optional[str] = Query(
        None, description="positive | negative | neutral"
    ),
    source: Optional[str] = Query(
        None, description="steam_review | steam_forum | reddit | bluesky"
    ),
    relevance: Optional[str] = Query(
        None,
        description=(
            "Filter by relevance_tier. Values: 'signal' (dedicated_sub + "
            "keyword matches), 'noise' (broad-sub no-match), 'dedicated_sub' "
            "(dedicated-source only), 'keyword_match' (broad-sub match only), "
            "'unclassified' (untagged), 'all' (include noise too). Default "
            "omits noise-tier posts — pass 'all' to include them."
        ),
    ),
    date_from: Optional[str] = Query(
        None, description="ISO date string, e.g. 2024-01-15"
    ),
    date_to: Optional[str] = Query(
        None, description="ISO date string, e.g. 2024-01-22"
    ),
    days: Optional[int] = Query(
        None,
        ge=1,
        le=3650,
        description=(
            "Convenience filter: last N days by COALESCE(post_date, collected_at). "
            "Matches the rule used by the weekly digest and dashboard so a post is "
            "included when its authorship date is within the window, or when it "
            "lacks a post_date but was ingested within the window. Overrides "
            "date_from when set; date_to is still honored."
        ),
    ),
    # Pagination
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """
    Browse raw posts with optional filtering and pagination.

    Returns 50 posts per page by default (configurable up to 200).
    Posts are ordered newest-collected first.
    """
    if not db.query(Game).filter_by(id=game_id).first():
        raise HTTPException(status_code=404, detail="Game not found.")

    # Base query — outer-join SentimentRecord so unclassified posts are included
    q = (
        db.query(RawPost)
        .outerjoin(RawPost.sentiment_record)
        .options(contains_eager(RawPost.sentiment_record))
        .filter(RawPost.game_id == game_id)
    )

    # ── Filters ───────────────────────────────────────────────────────────────

    if sentiment:
        try:
            se = SentimentEnum(sentiment)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid sentiment '{sentiment}'. "
                       f"Valid values: positive, negative, neutral",
            )
        # Filtering by sentiment implicitly excludes unclassified posts
        q = q.filter(SentimentRecord.sentiment == se)

    if source:
        try:
            src = SourceEnum(source)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid source '{source}'. "
                       f"Valid values: steam_review, steam_forum, reddit, bluesky",
            )
        q = q.filter(RawPost.source == src)

    # v0030 (2026-09-01): the default view now HIDES noise-tier posts — they
    # are broad-sub posts that failed the keyword gate and are not about the
    # game (verified: Road Kings had 5,425 mistagged reddit_comment rows on
    # trucking-industry / peripheral subs). Pass ?relevance=noise to see only
    # noise; pass ?relevance=all to include noise in the mix. All other
    # values behave as before.
    if relevance:
        # 'signal' is a convenience alias meaning "anything we'd surface
        # to analytics": dedicated_sub OR keyword-matched broad-sub post.
        if relevance == "signal":
            q = q.filter(RawPost.relevance_tier.in_(("dedicated_sub", "signal")))
        elif relevance == "keyword_match":
            q = q.filter(RawPost.relevance_tier == "signal")
        elif relevance == "unclassified":
            # NULL matches nothing under '=', so use IS NULL.
            q = q.filter(RawPost.relevance_tier.is_(None))
        elif relevance in ("dedicated_sub", "noise"):
            q = q.filter(RawPost.relevance_tier == relevance)
        elif relevance == "all":
            # No filter — include every tier including noise.
            pass
        else:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid relevance '{relevance}'. Valid values: "
                    "signal, keyword_match, dedicated_sub, noise, "
                    "unclassified, all"
                ),
            )
    else:
        # v0030: default = exclude noise. This is a behavior change from
        # "return everything when no filter is set" — the previous default
        # surfaced mistagged posts to the UI. Callers who want the old
        # behavior pass ?relevance=all explicitly.
        q = q.filter(
            (RawPost.relevance_tier != "noise") | RawPost.relevance_tier.is_(None)
        )

    if days is not None:
        # Convenience filter: last N days by COALESCE(post_date, collected_at).
        # Same rule the weekly digest uses (period_summary_service._aggregate_window_data)
        # so consumers of this endpoint see the same numbers as the dashboard.
        from sqlalchemy import func as _func
        from datetime import timezone as _tz, timedelta as _td
        cutoff = datetime.now(_tz.utc) - _td(days=days)
        q = q.filter(
            _func.coalesce(RawPost.post_date, RawPost.collected_at) >= cutoff
        )
    elif date_from:
        try:
            from sqlalchemy import func as _func
            q = q.filter(
                _func.coalesce(RawPost.post_date, RawPost.collected_at) >= datetime.fromisoformat(date_from)
            )
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid date_from '{date_from}'. Use ISO format YYYY-MM-DD.",
            )

    if date_to:
        try:
            from sqlalchemy import func as _func
            q = q.filter(
                _func.coalesce(RawPost.post_date, RawPost.collected_at) <= datetime.fromisoformat(date_to)
            )
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid date_to '{date_to}'. Use ISO format YYYY-MM-DD.",
            )

    # ── Pagination ────────────────────────────────────────────────────────────

    total: int = q.count()
    total_pages = math.ceil(total / page_size) if total else 1

    posts: List[RawPost] = (
        q.order_by(RawPost.collected_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    # ── Serialise ─────────────────────────────────────────────────────────────

    items = []
    for post in posts:
        sr: Optional[SentimentRecord] = post.sentiment_record
        sentiment_info = (
            PostSentimentInfo(
                sentiment=sr.sentiment.value,
                sentiment_score=sr.sentiment_score,
                topics=sr.topics,
            )
            if sr else None
        )
        items.append(RawPostResponse(
            id=post.id,
            game_id=post.game_id,
            source=post.source.value,
            external_id=post.external_id,
            author=post.author,
            title=post.title,
            body=post.body,
            url=post.url,
            upvotes=post.upvotes,
            collected_at=post.collected_at,
            post_date=post.post_date,
            sentiment_info=sentiment_info,
            relevance_tier=post.relevance_tier,
            matched_keywords=post.matched_keywords,
            parent_external_id=post.parent_external_id,
        ))

    return PostsPageResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )


# ─── Relevance audit summary ────────────────────────────────────────────

@router.get("/{game_id}/audit")
def get_relevance_audit(
    game_id: int,
    days: int = Query(30, ge=1, le=365, description="Rolling window in days"),
    db: Session = Depends(get_db),
):
    """
    Return a summary of the relevance-tier distribution for this game's
    posts over the last N days. Fields:

      - total: total posts in window
      - by_tier: {'signal': N, 'noise': N, 'dedicated_sub': N, ...}
      - by_source_and_tier: {'reddit': {'signal': N, 'noise': N, ...}, ...}
      - top_noise_subreddits: [{subreddit, count}, ...] top 20
      - keywords_used: the keyword list applied for this game
      - unclassified_pct: fraction of rows not yet tagged (informational)

    Used by the operator UI + morning-scan job to decide whether the
    tagger is behaving as expected and whether the keyword list needs
    tuning.
    """
    import re
    from collections import Counter, defaultdict
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import func as _func

    game = db.query(Game).filter_by(id=game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found.")

    from services.relevance_tagger import build_keywords_for_game
    keywords = build_keywords_for_game(game)

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (
        db.query(RawPost.id, RawPost.source, RawPost.url,
                 RawPost.relevance_tier)
        .filter(RawPost.game_id == game_id)
        .filter(_func.coalesce(RawPost.post_date, RawPost.collected_at) >= cutoff)
        .all()
    )
    total = len(rows)
    by_tier = Counter(r.relevance_tier or "unclassified" for r in rows)
    by_source_and_tier: defaultdict[str, Counter] = defaultdict(Counter)
    noise_subs: Counter = Counter()
    sub_re = re.compile(r"/r/([^/]+)/", re.IGNORECASE)

    for r in rows:
        source_str = r.source.value if r.source else "unknown"
        tier = r.relevance_tier or "unclassified"
        by_source_and_tier[source_str][tier] += 1
        if tier == "noise" and source_str == "reddit" and r.url:
            m = sub_re.search(r.url)
            if m:
                noise_subs[m.group(1)] += 1

    return {
        "game_id": game_id,
        "game_name": game.name,
        "window_days": days,
        "cutoff": cutoff.isoformat(),
        "total": total,
        "by_tier": dict(by_tier),
        "by_source_and_tier": {
            src: dict(counts) for src, counts in by_source_and_tier.items()
        },
        "top_noise_subreddits": [
            {"subreddit": sub, "count": n}
            for sub, n in noise_subs.most_common(20)
        ],
        "keywords_used": keywords,
        "unclassified_pct": (
            round(100 * by_tier.get("unclassified", 0) / total, 2)
            if total else 0.0
        ),
    }


@router.get("/{game_id}/classifier-audit")
def get_classifier_audit(
    game_id: int,
    days: int = Query(30, ge=1, le=365, description="Rolling window in days"),
    db: Session = Depends(get_db),
):
    """
    Diagnostic endpoint (2026-08-12, Steve backfill investigation): report,
    per source, how many rows have vs lack a SentimentRecord. Splits by
    is_relevant status so we can see if Step 5's relevance gate ate rows.

    Answers: 'how many landed rows never got classified and why?'
    """
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import func as _func
    from models import SentimentRecord as _SR

    game = db.query(Game).filter_by(id=game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found.")

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    rows = (
        db.query(
            RawPost.source,
            RawPost.is_relevant,
            _SR.id.label("sr_id"),
        )
        .outerjoin(_SR, _SR.raw_post_id == RawPost.id)
        .filter(RawPost.game_id == game_id)
        .filter(_func.coalesce(RawPost.post_date, RawPost.collected_at) >= cutoff)
        .all()
    )

    result: dict[str, dict[str, int]] = {}
    for r in rows:
        src = r.source.value if r.source else "unknown"
        if src not in result:
            result[src] = {
                "total": 0,
                "has_sentiment": 0,
                "no_sentiment_is_relevant_null": 0,
                "no_sentiment_is_relevant_true": 0,
                "no_sentiment_is_relevant_false": 0,
            }
        result[src]["total"] += 1
        if r.sr_id is not None:
            result[src]["has_sentiment"] += 1
        else:
            if r.is_relevant is None:
                result[src]["no_sentiment_is_relevant_null"] += 1
            elif r.is_relevant is True:
                result[src]["no_sentiment_is_relevant_true"] += 1
            else:
                result[src]["no_sentiment_is_relevant_false"] += 1

    return {
        "game_id": game_id,
        "game_name": game.name,
        "window_days": days,
        "cutoff": cutoff.isoformat(),
        "by_source": result,
    }
