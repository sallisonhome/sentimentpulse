"""YouTube source-card counts use comment dates, agree with KPI, include competitors."""
from datetime import date, datetime, timedelta
from unittest.mock import patch

import pytest

from models import RawPost, SourceEnum, SentimentEnum, SentimentRecord, Game, CompetitorGame
from schemas import PeriodEnum
from routers.dashboard import _compute_dashboard


def add(db, game, days_ago, drift=False):
    post = RawPost(game_id=game.id, source=SourceEnum.youtube_comment,
                   external_id=f"yt:{game.id}:{days_ago}:{drift}", body="Great combat",
                   post_date=datetime.combine(date.today() - timedelta(days=days_ago), datetime.min.time()),
                   collected_at=datetime.utcnow(), relevance_tier="signal", is_relevant=True,
                   is_off_topic_drift=drift)
    db.add(post)
    db.flush()
    db.add(SentimentRecord(raw_post_id=post.id, sentiment=SentimentEnum.positive, sentiment_score=.9))


@pytest.mark.parametrize("period,expected", [
    ("today", 1), ("weekly", 2), ("monthly", 3), ("quarterly", 4), ("lifetime", 5),
])
@pytest.mark.parametrize("competitor", [False, True])
def test_source_card_matches_kpi_by_comment_date(db, game, publisher, period, expected, competitor):
    target = game
    if competitor:
        target = Game(publisher_id=publisher.id, name="Competitor", steam_app_id=888, is_active=True)
        db.add(target)
        db.flush()
        db.add(CompetitorGame(parent_id=game.id, competitor_id=target.id))
    for age in (0, 4, 20, 60, 400):
        add(db, target, age)
    add(db, target, 0, drift=True)
    db.commit()
    result = _compute_dashboard(target.id, PeriodEnum(period), db)
    assert sum(p.youtube_comment for p in result.volume_by_source) == expected
    assert sum(p.total for p in result.volume_by_source) == expected
    assert result.sentiment_today.total == expected
    if competitor:
        parent = _compute_dashboard(game.id, PeriodEnum(period), db)
        assert sum(p.youtube_comment for p in parent.volume_by_source) == 0


def test_prior_period_youtube_counts_and_total(db, game):
    # Populate enough prior-week dates to satisfy the existing coverage guard.
    for age in (0, 7, 8, 9, 10):
        add(db, game, age)
    db.commit()
    result = _compute_dashboard(game.id, PeriodEnum.weekly, db)
    assert sum(p.youtube_comment for p in result.volume_by_source) == 1
    assert result.prior_period_volume_by_source is not None
    assert sum(p.youtube_comment for p in result.prior_period_volume_by_source) == 4
    assert sum(p.total for p in result.prior_period_volume_by_source) == 4


def test_warmup_invalidates_older_imports_and_inflight_stale_keys(db, game, monkeypatch):
    from sqlalchemy.orm import sessionmaker
    import database
    from routers import dashboard as router

    router._DASHBOARD_CACHE.clear()
    add(db, game, 0)
    db.commit()
    before = router.get_dashboard(game.id, PeriodEnum.monthly, db)
    stamp = router._latest_post_date_for_game(db, game.id)
    old_key = router._cache_key(game.id, PeriodEnum.monthly, stamp)
    assert sum(p.youtube_comment for p in before.volume_by_source) == 1
    add(db, game, 4)  # Older imported comment cannot move MAX(post_date).
    db.commit()
    assert router._latest_post_date_for_game(db, game.id) == stamp
    monkeypatch.setattr(database, "SessionLocal", sessionmaker(bind=db.get_bind()))
    result = router.warmup_dashboard_cache()
    assert result["errors"] == []
    assert result["entries_written"] == 5
    assert router._cache_key(game.id, PeriodEnum.monthly, stamp) != old_key
    router._DASHBOARD_CACHE[old_key] = before  # Simulate a late stale response.
    after = router.get_dashboard(game.id, PeriodEnum.monthly, db)
    assert sum(p.youtube_comment for p in after.volume_by_source) == 2
    assert after.sentiment_today.total == 2
    router._DASHBOARD_CACHE.clear()
