import json
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session

from models import Game, Publisher
from routers import dashboard as router
from schemas import PeriodEnum
from services import topic_snapshots as store
from services import dashboard_feedback_synthesizer as synth
from services import llm_client


@pytest.fixture
def game(db):
    pub = Publisher(name="Topic tests")
    db.add(pub)
    db.flush()
    game = Game(name="Any Portfolio Game", publisher_id=pub.id, steam_app_id=999,
                is_active=True)
    db.add(game)
    db.commit()
    return game


def fill(db, gid, period="weekly", sentiment="positive", payload=None):
    start = router._period_start(PeriodEnum(period))
    store.write(db, gid, period, sentiment, start, store.generation(db),
                payload if payload is not None else [
                    {"label": "Melee Combat", "detail": "Hits feel weighty.", "volume": 4}])


@pytest.mark.parametrize("period", store.PERIODS)
def test_every_supported_window_persists_across_memory_loss(db, game, monkeypatch, period):
    for s in store.SENTIMENTS:
        fill(db, game.id, period, s)
    synth._CACHE.clear()  # simulate a process restart: nothing in the old TTL cache
    queue = Mock()
    monkeypatch.setattr(router, "_queue_topics", queue)
    with Session(db.get_bind()) as restarted:
        result = router.get_dashboard_topics(game.id, PeriodEnum(period), restarted)
    assert result.status == "ready"
    assert all(getattr(result, s) for s in store.SENTIMENTS)
    queue.assert_not_called()


def test_partial_bucket_does_not_hide_valid_topics(db, game, monkeypatch):
    fill(db, game.id)
    monkeypatch.setattr(router, "_queue_topics", Mock())
    result = router.get_dashboard_topics(game.id, PeriodEnum.weekly, db)
    assert result.positive[0].label == "Melee Combat"
    assert result.status == "refreshing"
    assert result.bucket_status == {"positive": "ready", "negative": "pending", "neutral": "pending"}


@pytest.mark.parametrize("period", ("quarterly", "lifetime"))
def test_unsupported_windows_never_queue_work(db, game, monkeypatch, period):
    queue = Mock()
    monkeypatch.setattr(router, "_queue_topics", queue)
    result = router.get_dashboard_topics(game.id, PeriodEnum(period), db)
    assert result.status == "unsupported"
    assert result.message == store.UNSUPPORTED_MESSAGE
    queue.assert_not_called()


def test_generation_refresh_preserves_prior_result_on_failure(db, game):
    fill(db, game.id)
    start = router._period_start(PeriodEnum.weekly)
    gen = store.invalidate(db)
    row = store.read(db, game.id, "weekly", "positive", start)
    assert row["payload"] and not store.fresh(row, gen)
    store.write(db, game.id, "weekly", "positive", start, gen, None, error="model unavailable")
    row = store.read(db, game.id, "weekly", "positive", start)
    assert row["payload"][0]["label"] == "Melee Combat"
    assert not store.retry_due(row, gen)


def test_empty_success_is_ready_not_a_failure(db, game, monkeypatch):
    for s in store.SENTIMENTS:
        fill(db, game.id, sentiment=s, payload=[])
    queue = Mock()
    monkeypatch.setattr(router, "_queue_topics", queue)
    result = router.get_dashboard_topics(game.id, PeriodEnum.weekly, db)
    assert result.status == "ready"
    assert result.positive == []
    queue.assert_not_called()


def test_date_rollover_does_not_mislabel_yesterday_as_today(db, game):
    yesterday = date.today() - timedelta(days=1)
    store.write(db, game.id, "today", "positive", yesterday, store.generation(db), [])
    assert store.read(db, game.id, "today", "positive", date.today()) is None


def test_old_generation_worker_cannot_overwrite_new_result(db, game):
    old = store.generation(db)
    store.invalidate(db)
    fill(db, game.id)
    store.write(db, game.id, "weekly", "positive", router._period_start(PeriodEnum.weekly),
                old, [])
    assert store.read(db, game.id, "weekly", "positive",
                      router._period_start(PeriodEnum.weekly))["payload"]


@pytest.mark.parametrize("text", ["", "I cannot return JSON", '{"topics": ['])
def test_invalid_primary_triggers_validated_fallback(monkeypatch, text):
    valid = json.dumps({"topics": [{"label": "Combat", "detail": "Hits feel weighty.",
                                  "posts": [1, 2, 3]}]})
    primary = SimpleNamespace(available=lambda: True, call=Mock(return_value=SimpleNamespace(
        text=text, source="primary", elapsed_s=0)))
    fallback = SimpleNamespace(available=lambda: True, call=Mock(return_value=SimpleNamespace(
        text=valid, source="fallback", elapsed_s=0)))
    monkeypatch.setattr(llm_client, "_resolve_backend_id", lambda _: "primary")
    monkeypatch.setattr(llm_client, "_resolve_fallback_id", lambda _: "fallback")
    monkeypatch.setattr(llm_client, "_make_backend",
                        lambda name, **_: primary if name == "primary" else fallback)
    result = llm_client.call_llm("posts", block_kind="topics",
                                validate_response=lambda t: synth._parse_aspect_response(t, 3))
    assert result.text == valid
    fallback.call.assert_called_once()


def test_warmup_automatically_visits_all_active_games_and_three_windows(db, game, monkeypatch):
    from concurrent.futures import Future
    from database import SessionLocal
    import database
    second = Game(name="Second", publisher_id=game.publisher_id, steam_app_id=998, is_active=True)
    hidden = Game(name="Hidden", publisher_id=game.publisher_id, steam_app_id=997, is_active=False)
    db.add_all([second, hidden]); db.commit()
    bind = db.get_bind()
    monkeypatch.setattr(database, "SessionLocal", lambda: Session(bind))
    seen = []
    def queue(gid, name, period, start):
        seen.append((gid, period))
        with Session(bind) as s:
            for sentiment in store.SENTIMENTS:
                fill(s, gid, period, sentiment)
        future = Future(); future.set_result(None)
        return future
    monkeypatch.setattr(router, "_queue_topics", queue)
    result = router.warmup_topics_cache()
    assert set(seen) == {(g, p) for g in (game.id, second.id) for p in store.PERIODS}
    assert result["entries_warmed"] == 6 and not result["errors"]


def test_worker_to_api_roundtrip_and_restart(db, game, monkeypatch):
    from datetime import datetime, timezone
    from models import RawPost, SentimentRecord, SourceEnum, SentimentEnum
    import database
    for i in range(3):
        post = RawPost(game_id=game.id, source=SourceEnum.steam_review,
                       external_id=f"roundtrip-{i}", is_relevant=True,
                       relevance_tier="signal", is_off_topic_drift=False,
                       body="The melee combat feels great, every hit has real weight.",
                       post_date=datetime.now(timezone.utc),
                       collected_at=datetime.now(timezone.utc))
        db.add(post); db.flush()
        db.add(SentimentRecord(raw_post_id=post.id, sentiment=SentimentEnum.positive,
                               sentiment_score=.9, topics=[]))
    db.commit()
    monkeypatch.setattr(database, "SessionLocal", lambda: Session(db.get_bind()))
    model = Mock(return_value=SimpleNamespace(text=json.dumps({"topics": [
        {"label": "Melee Combat", "detail": "Every hit feels weighty.", "posts": [1, 2, 3]}
    ]})))
    monkeypatch.setattr(llm_client, "call_llm", model)
    router._synthesize_topics_background(game.id, game.name, "monthly",
                                         router._period_start(PeriodEnum.monthly))
    synth._CACHE.clear()
    queue = Mock(); monkeypatch.setattr(router, "_queue_topics", queue)
    result = router.get_dashboard_topics(game.id, PeriodEnum.monthly, db)
    assert result.status == "ready"
    assert result.positive[0].label == "Melee Combat"
    assert result.negative == result.neutral == []
    assert model.call_count == 1
    queue.assert_not_called()
