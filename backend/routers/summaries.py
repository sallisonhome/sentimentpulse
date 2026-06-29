"""
Summaries router — all summary endpoints.

  GET  /api/games/{game_id}/summaries                     → daily summaries list
  GET  /api/games/{game_id}/summaries/latest              → most recent daily summary
  GET  /api/games/{game_id}/monthly-summaries             → list all monthly summaries
  GET  /api/games/{game_id}/monthly-summaries/{year}/{month} → single monthly summary
  POST /api/games/{game_id}/window-summary                → on-demand N-day summary
"""
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
from models import DailySummary, Game, MonthlySummary, WindowSummary
from schemas import (
    DailySummaryResponse,
    MonthlySummaryResponseWithLabel,
    PeriodEnum,
    WindowSummaryRequest,
    WindowSummaryResponse,
)
from services import period_summary_service as _pss

router = APIRouter(prefix="/games", tags=["summaries"])

# 2026-06-29 diagnostic: surface the in-memory bold-ideas trace ring buffer
# so we can see which layer is dropping ideas in production.  This endpoint
# lives outside the /games prefix and is read-only.
_diag_router = APIRouter(prefix="/diagnostics", tags=["diagnostics"])


@_diag_router.get("/bold-ideas-trace")
def get_bold_ideas_trace():
    """Return the last N _call_bold_ideas trace entries, newest last.

    Each entry records the raw LLM length, after-parse count, and the
    survivors at every sanitizer layer.  Used to diagnose why the live
    digest is showing 0 bold ideas across substantive titles.
    """
    return {"trace": _pss.get_bold_trace_buffer()}


@_diag_router.post("/editorial-cache-clear")
def clear_editorial_cache(
    game_id: Optional[int] = None,
    scope: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """§24 admin endpoint: delete cached editorial articles.

    Optional filters:
      - game_id: clear only one game's cache
      - scope: 'weekly' or 'monthly', clear only one scope
    Both omitted: clears the entire editorial_articles table (use with care).

    Returns the row count deleted.
    """
    from models import EditorialArticle
    q = db.query(EditorialArticle)
    if game_id is not None:
        q = q.filter(EditorialArticle.game_id == game_id)
    if scope is not None:
        q = q.filter(EditorialArticle.scope == scope)
    deleted = q.delete(synchronize_session=False)
    db.commit()
    return {"deleted": deleted, "game_id": game_id, "scope": scope}


@_diag_router.get("/editorial-cache-summary")
def editorial_cache_summary(db: Session = Depends(get_db)):
    """§24 admin endpoint: count editorial articles per (game_id, scope, cycle_start).

    §24b extension: also reports body_populated_count and avg_body_chars so
    we can verify the Playwright fetch path actually captured body text
    (vs the title-only fallback).
    """
    from models import EditorialArticle, Game
    from sqlalchemy import func as _f, case as _case
    rows = (
        db.query(
            EditorialArticle.game_id,
            Game.name,
            EditorialArticle.scope,
            EditorialArticle.cycle_start,
            _f.count(EditorialArticle.id).label("article_count"),
            _f.sum(
                _case((_f.length(EditorialArticle.body) > 200, 1), else_=0)
            ).label("body_populated_count"),
            _f.avg(_f.length(EditorialArticle.body)).label("avg_body_chars"),
            _f.max(_f.length(EditorialArticle.body)).label("max_body_chars"),
        )
        .join(Game, Game.id == EditorialArticle.game_id)
        .group_by(
            EditorialArticle.game_id, Game.name,
            EditorialArticle.scope, EditorialArticle.cycle_start,
        )
        .order_by(EditorialArticle.cycle_start.desc(), EditorialArticle.game_id)
        .all()
    )
    return {
        "batches": [
            {
                "game_id": r.game_id,
                "game_name": r.name,
                "scope": r.scope,
                "cycle_start": r.cycle_start.isoformat() if r.cycle_start else None,
                "article_count": r.article_count,
                "body_populated_count": int(r.body_populated_count or 0),
                "avg_body_chars": int(r.avg_body_chars or 0),
                "max_body_chars": int(r.max_body_chars or 0),
            }
            for r in rows
        ],
        "total_batches": len(rows),
    }


@_diag_router.get("/editorial-articles")
def editorial_articles_list(
    game_id: int,
    scope: str = "weekly",
    db: Session = Depends(get_db),
):
    """§24b admin endpoint: list editorial article rows for a single batch with
    per-article body length + URL + publication so we can verify the Playwright
    body fetch is hitting real publisher pages (not Google News interstitials).
    """
    from models import EditorialArticle
    rows = (
        db.query(EditorialArticle)
        .filter_by(game_id=game_id, scope=scope)
        .order_by(EditorialArticle.cycle_start.desc(), EditorialArticle.cite)
        .limit(50)
        .all()
    )
    return {
        "game_id": game_id,
        "scope": scope,
        "articles": [
            {
                "cite": a.cite,
                "cycle_start": a.cycle_start.isoformat() if a.cycle_start else None,
                "url": a.url,
                "publication": a.publication,
                "title": a.title,
                "body_chars": len(a.body) if a.body else 0,
                "body_excerpt": (a.body[:300] if a.body else ""),
                "summary_chars": len(a.summary) if a.summary else 0,
            }
            for a in rows
        ],
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _period_start(period: PeriodEnum) -> Optional[date]:
    today = date.today()
    return {
        PeriodEnum.today:     today,
        PeriodEnum.weekly:    today - timedelta(days=7),
        PeriodEnum.monthly:   today - timedelta(days=30),
        PeriodEnum.quarterly: today - timedelta(days=90),
        PeriodEnum.lifetime:  None,
    }[period]


def _get_game_or_404(db: Session, game_id: int) -> Game:
    game = db.query(Game).filter_by(id=game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found.")
    return game


# ── Daily Summaries ───────────────────────────────────────────────────────────

@router.get("/{game_id}/summaries", response_model=List[DailySummaryResponse])
def get_summaries(
    game_id: int,
    period: PeriodEnum = Query(PeriodEnum.weekly),
    db: Session = Depends(get_db),
):
    """
    Return daily summaries for a game, newest first.
    Use ?period=weekly|monthly|quarterly|lifetime to limit the date window.
    """
    _get_game_or_404(db, game_id)

    q = db.query(DailySummary).filter(DailySummary.game_id == game_id)

    start = _period_start(period)
    if start:
        q = q.filter(DailySummary.summary_date >= start)

    return q.order_by(DailySummary.summary_date.desc()).all()


@router.get("/{game_id}/summaries/latest", response_model=DailySummaryResponse)
def get_latest_summary(
    game_id: int,
    db: Session = Depends(get_db),
):
    """Return the most recent daily summary for a game."""
    _get_game_or_404(db, game_id)

    summary = (
        db.query(DailySummary)
        .filter(DailySummary.game_id == game_id)
        .order_by(DailySummary.summary_date.desc())
        .first()
    )
    if not summary:
        raise HTTPException(status_code=404, detail="No summaries found for this game.")
    return summary


# ── Monthly Summaries ─────────────────────────────────────────────────────────

@router.get("/{game_id}/monthly-summaries", response_model=List[MonthlySummaryResponseWithLabel])
def get_monthly_summaries(
    game_id: int,
    db: Session = Depends(get_db),
):
    """
    Return all monthly summaries for a game, newest first.
    Each row includes a computed month_label (e.g. "April 2026").
    """
    _get_game_or_404(db, game_id)

    rows = (
        db.query(MonthlySummary)
        .filter(MonthlySummary.game_id == game_id)
        .order_by(
            MonthlySummary.period_year.desc(),
            MonthlySummary.period_month.desc(),
        )
        .all()
    )
    return [MonthlySummaryResponseWithLabel.from_orm_with_label(r) for r in rows]


@router.get(
    "/{game_id}/monthly-summaries/{year}/{month}",
    response_model=MonthlySummaryResponseWithLabel,
)
def get_monthly_summary(
    game_id: int,
    year: int,
    month: int,
    db: Session = Depends(get_db),
):
    """
    Return a single monthly summary for the given (year, month).
    Returns 404 if not yet generated.
    """
    _get_game_or_404(db, game_id)

    row = (
        db.query(MonthlySummary)
        .filter_by(game_id=game_id, period_year=year, period_month=month)
        .first()
    )
    if not row:
        raise HTTPException(
            status_code=404,
            detail=f"Monthly summary for {year}-{month:02d} has not been generated yet.",
        )
    return MonthlySummaryResponseWithLabel.from_orm_with_label(row)


@router.post(
    "/{game_id}/monthly-summaries/{year}/{month}/regenerate",
    response_model=MonthlySummaryResponseWithLabel,
)
def regenerate_monthly_summary(
    game_id: int,
    year: int,
    month: int,
    db: Session = Depends(get_db),
):
    """Force-regenerate the MonthlySummary for (game_id, year, month).

    `generate_monthly_summary` is upsert-safe: any existing row is overwritten
    in place with fresh Claude output using the current prompt logic.
    Synchronous; expect ~30 s on cache miss.

    Used to backfill historical summaries with new prompt logic without
    waiting for the next 1st-of-month cron rollover.
    """
    _get_game_or_404(db, game_id)
    try:
        row = _pss.generate_monthly_summary(db, game_id=game_id, year=year, month=month)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Regeneration failed: {exc}")
    return MonthlySummaryResponseWithLabel.from_orm_with_label(row)


# ── Window (On-demand) Summary ───────────────────────────────────────────────

@router.post("/{game_id}/window-summary", response_model=WindowSummaryResponse)
def create_window_summary(
    game_id: int,
    body: WindowSummaryRequest = Body(default=WindowSummaryRequest()),
    force: bool = Query(
        False,
        description=(
            "If true, delete the existing WindowSummary row for "
            "(game_id, days, today's ingest_date) before generating. "
            "Use after deploying summary-prompt changes to bust the cache."
        ),
    ),
    db: Session = Depends(get_db),
):
    """
    Generate (or return cached) a rolling-window summary for the specified game.

    body.days defaults to 7.  The cache key is (game_id, days, last_ingest_date)
    so the same calendar day always returns the same result instantly.

    Synchronously calls Claude when not cached; expect ~10-15 s on cache miss.

    Pass ?force=true to bust today's cache and force a fresh generation.
    """
    _get_game_or_404(db, game_id)

    # ── Cache-bust (force=true) ─────────────────────────────────────────────
    if force:
        from models import WindowSummary, RawPost
        from sqlalchemy import func
        # Re-derive ingest_date the same way generate_window_summary does so
        # we delete the exact row that would otherwise be returned.
        effective_date = func.coalesce(RawPost.post_date, RawPost.collected_at)
        max_dt = (
            db.query(func.max(effective_date))
            .filter(RawPost.game_id == game_id)
            .scalar()
        )
        if max_dt is not None:
            from datetime import datetime as _dt, date as _date
            if isinstance(max_dt, _dt):
                ingest_date = max_dt.date()
            elif isinstance(max_dt, _date):
                ingest_date = max_dt
            else:
                ingest_date = date.today()
            (
                db.query(WindowSummary)
                .filter_by(
                    game_id=game_id,
                    window_days=body.days,
                    ingest_date=ingest_date,
                )
                .delete()
            )
            db.commit()

    try:
        row = _pss.generate_window_summary(db, game_id=game_id, days=body.days)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Summary generation failed: {exc}")

    return WindowSummaryResponse.model_validate(row)
