"""SentimentPulse TikTok comment ingestion tests. Mirrors test_youtube_import.py."""
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

import pytest

from models import AppSetting, Game, CompetitorGame, RawPost, SourceEnum, SentimentEnum, SentimentRecord
from services.tiktok_service import (
    import_game_comments,
    import_enabled_global,
    import_enabled_for_game,
    feed_options,
)
from services.tiktok_service import EPOCH


def stamp(days=0):
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@pytest.fixture
def configured(db):
    db.add(AppSetting(key="tiktok_feed_ops_token", value="test-only-not-a-real-token"))
    db.commit()


def comment(game, cid="c1", text="The combat looks fantastic", fetched=None):
    return dict(commentId=cid, awemeId="aw1", steamAppId=str(game.steam_app_id),
                videoDesc="A terrible VIDEO desc, not the comment",
                parentId=None, authorUniqueId="author1", url="https://tiktok.com/@x/v/aw1",
                text=text, likeCount=2, createTime=stamp(-10), fetchedAt=fetched or stamp(-2))


def payload(comments=(), tombstones=(), next_cursor=None, snapshot=None):
    return dict(feedVersion=1, source="tiktok_comment", snapshotAt=snapshot or stamp(),
                comments=list(comments), tombstones=list(tombstones), nextCursor=next_cursor)


def getter(*pages):
    """Mock transport that keeps serving an empty page after the mock's
    side_effect list runs out so the loop ends naturally instead of raising
    StopIteration."""
    last_empty = payload([])
    responses = [Mock(status_code=200, json=Mock(return_value=p)) for p in pages]
    responses.extend([Mock(status_code=200, json=Mock(return_value=last_empty)) for _ in range(200)])
    return Mock(side_effect=responses)



def cursor_row(db, game):
    return db.get(AppSetting, f"tiktok_feed_cursor:{game.id}:{game.steam_app_id}")


def test_disabled_by_default_and_secure_transport(db, configured):
    assert import_enabled_global(db) is False
    db.add(AppSetting(key="tiktok_feed_base_url", value="http://remote.example"))
    db.commit()
    with pytest.raises(ValueError, match="requires HTTPS"):
        feed_options(db)


def test_per_title_gate_and_global_fallback(db, game, configured):
    assert import_enabled_for_game(db, game) is False  # per-title off, global off
    db.add(AppSetting(key="tiktok_comment_enabled", value="true"))
    db.commit()
    assert import_enabled_for_game(db, game) is True  # falls back to global on
    db.add(AppSetting(key=f"tiktok_comment_enabled:{game.id}", value="false"))
    db.commit()
    assert import_enabled_for_game(db, game) is False  # per-title false overrides global
    db.query(AppSetting).filter_by(key=f"tiktok_comment_enabled:{game.id}").delete()
    db.commit()
    assert import_enabled_for_game(db, game) is True  # falls back again after clear


def test_competitor_stays_under_own_game_and_idempotent_replay(db, game, publisher, configured):
    child = Game(publisher_id=publisher.id, steam_app_id=777, name="Competitor", is_active=True)
    db.add(child)
    db.flush()
    db.add(CompetitorGame(parent_id=game.id, competitor_id=child.id))
    db.commit()

    item = comment(child)
    get = getter(payload([item, item]))
    result = import_game_comments(db, child, get=get)
    assert result["inserted"] == 1
    post = db.query(RawPost).one()
    assert post.game_id == child.id
    assert post.source == SourceEnum.tiktok_comment
    assert post.parent_external_id == "tiktok-video:aw1"
    assert post.post_date < post.collected_at
    assert post.relevance_tier == "signal"
    result = import_game_comments(db, child, get=getter(payload([item])))
    assert result["inserted"] == 0
    assert db.query(RawPost).count() == 1
    assert get.call_args.kwargs["timeout"] == (5, 30)


def test_cursor_advances_and_resumes_within_same_snapshot(db, game, configured):
    # Cap at 1 page so the mock doesn't keep feeding empty pages past the
    # first real response (which has nextCursor="page2").
    snapshot = stamp()
    first = getter(payload([comment(game, cid="c1")], next_cursor="page2", snapshot=snapshot))
    import_game_comments(db, game, get=first, max_pages=1)
    assert json.loads(cursor_row(db, game).value)["cursor"] == "page2"

    second = getter(payload([comment(game, cid="c2")], snapshot=snapshot))
    result = import_game_comments(db, game, get=second)
    assert result["inserted"] == 1
    # Watermark is 1s before snapshotAt; next run consumes only new comments.
    state = json.loads(cursor_row(db, game).value)
    assert "cursor" not in state
    # The saved watermark (1s before snapshotAt) is strictly newer than the
    # EPOCH default that the very first call used, and deletedSince advances.
    assert state["since"] != EPOCH
    assert state["deletedSince"] == state["since"]


def test_edited_comment_updates_body_and_resets_sentiment(db, game, configured):
    item = comment(game, cid="c1", text="original text")
    import_game_comments(db, game, get=getter(payload([item])))

    post = db.query(RawPost).one()
    post.is_relevant = True
    db.add(SentimentRecord(raw_post_id=post.id, sentiment=SentimentEnum.positive,
                           sentiment_score=0.9))
    db.commit()

    edited = comment(game, cid="c1", text="edited text")
    result = import_game_comments(db, game, get=getter(payload([edited])))
    assert result["updated"] == 1
    post = db.query(RawPost).one()
    assert post.body == "edited text"
    assert post.is_relevant is None
    assert post.relevance_tier == "signal"
    assert db.query(SentimentRecord).count() == 0


def test_tombstone_removes_sentiment_but_preserves_text(db, game, configured):
    item = comment(game, cid="c1")
    import_game_comments(db, game, get=getter(payload([item])))
    post = db.query(RawPost).one()
    db.add(SentimentRecord(raw_post_id=post.id, sentiment=SentimentEnum.positive,
                           sentiment_score=0.9))
    db.commit()

    tomb = dict(cid="c1", steam_app_id=str(game.steam_app_id),
                deleted_at=stamp(), reason="upstream_removal")
    result = import_game_comments(db, game, get=getter(payload([comment(game, cid="c2")],
                                                               tombstones=[tomb])))
    assert result["excluded"] == 1
    assert result["inserted"] == 1
    post = db.query(RawPost).filter_by(external_id="tiktok:c1").one()
    assert post.body == "The combat looks fantastic"
    assert post.is_relevant is False
    assert post.is_off_topic_drift is True
    assert post.relevance_tier == "noise"
    assert post.matched_keywords == ["tiktok_excluded:upstream_removal"]
    assert db.query(SentimentRecord).count() == 0


def test_discriminator_prevents_crossover_by_steam_app_id(db, game, publisher, configured):
    child = Game(publisher_id=publisher.id, steam_app_id=777, name="Competitor", is_active=True)
    db.add(child)
    db.flush()
    db.add(CompetitorGame(parent_id=game.id, competitor_id=child.id))
    db.commit()

    wrong = comment(game)
    wrong["steamAppId"] = "777"  # belongs to child, not game
    with pytest.raises(ValueError, match="returned a different title"):
        import_game_comments(db, game, get=getter(payload([wrong])))


def test_comment_focused_gate_rejects_promo_comments(db, game):
    from services.tiktok_service import comment_is_focused
    assert comment_is_focused("This Warhammer game looks great", game) is True
    assert comment_is_focused("check out my channel for more", game) is False
