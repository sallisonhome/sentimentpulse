import json
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

import pytest

from models import AppSetting, Game, CompetitorGame, RawPost, SourceEnum, SentimentRecord, SentimentEnum
from services.youtube_service import import_game_comments, import_enabled, feed_options
from services.ingestor import _step5_classify_sentiment


def stamp(days=0):
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@pytest.fixture
def configured(db):
    db.add(AppSetting(key="youtube_feed_ops_token", value="test-only-not-a-real-token"))
    db.commit()


def comment(game, cid="c1", text="The combat looks fantastic", fetched=None):
    return dict(commentId=cid, videoId="v1", steamAppId=str(game.steam_app_id),
                videoTitle="A terribly negative VIDEO title, not the comment",
                parentId=None, authorChannelId="channel1", text=text,
                likeCount=2, publishedAt=stamp(-10), fetchedAt=fetched or stamp(-1))


def payload(comments=(), tombstones=(), next_cursor=None, snapshot=None, mode="unlimited"):
    return dict(feedVersion=2, source="youtube_comment", snapshotAt=snapshot or stamp(),
                comments=list(comments), tombstones=list(tombstones), nextCursor=next_cursor,
                retention={"mode": mode})


def getter(*pages):
    return Mock(side_effect=[Mock(status_code=200, json=Mock(return_value=p)) for p in pages])


def cursor_row(db, game):
    return db.get(AppSetting, f"youtube_feed_cursor:{game.id}:{game.steam_app_id}")


def test_disabled_by_default_and_secure_transport(db, configured):
    assert import_enabled(db) is False
    db.add(AppSetting(key="youtube_feed_base_url", value="http://remote.example"))
    db.commit()
    with pytest.raises(ValueError, match="requires HTTPS"):
        feed_options(db)


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
    assert post.source == SourceEnum.youtube_comment
    assert post.parent_external_id == "youtube-video:v1"
    assert post.post_date < post.collected_at
    assert post.relevance_tier == "signal"
    result = import_game_comments(db, child, get=getter(payload([item])))
    assert result["inserted"] == 0
    assert db.query(RawPost).count() == 1
    assert get.call_args.kwargs["timeout"] == (5, 30)
    assert get.call_args.kwargs["allow_redirects"] is False


def test_page_failure_resumes_without_advancing_failed_page(db, game, configured):
    snapshot = stamp()
    token = comment(game)["fetchedAt"] + "|c1"
    first = payload([comment(game)], next_cursor=token, snapshot=snapshot)
    get = Mock(side_effect=[Mock(status_code=200, json=lambda: first), Mock(status_code=503)])
    with pytest.raises(RuntimeError, match="HTTP 503"):
        import_game_comments(db, game, get=get)
    assert db.query(RawPost).count() == 1
    state = json.loads(cursor_row(db, game).value)
    assert state["cursor"] == token
    next_get = getter(payload([comment(game, "c2")], snapshot=snapshot))
    import_game_comments(db, game, get=next_get)
    assert next_get.call_args.kwargs["params"]["cursor"] == token
    assert next_get.call_args.kwargs["params"]["until"] == snapshot
    assert db.query(RawPost).count() == 2
    assert "cursor" not in json.loads(cursor_row(db, game).value)


def test_wrong_title_rolls_back_whole_page_and_cursor(db, game, configured):
    bad = comment(game, "bad")
    bad["steamAppId"] = "999"
    with pytest.raises(ValueError, match="different title"):
        import_game_comments(db, game, get=getter(payload([comment(game), bad])))
    assert db.query(RawPost).count() == 0
    assert cursor_row(db, game) is None


def test_edit_invalidates_old_sentiment_and_tombstone_preserves_raw_text(db, game, configured):
    import_game_comments(db, game, get=getter(payload([comment(game)])))
    post = db.query(RawPost).one()
    post.is_relevant = True
    db.add(SentimentRecord(raw_post_id=post.id, sentiment=SentimentEnum.positive, sentiment_score=.9))
    db.commit()
    changed = comment(game, text="Actually the combat is broken", fetched=stamp())
    result = import_game_comments(db, game, get=getter(payload([changed])))
    assert result["updated"] == 1
    assert db.query(SentimentRecord).count() == 0
    assert db.query(RawPost).one().is_relevant is None
    tomb = {"comment_id": "c1", "steam_app_id": str(game.steam_app_id), "deleted_at": stamp()}
    result = import_game_comments(db, game, get=getter(payload([], [tomb])))
    assert result["excluded"] == 1
    assert db.query(RawPost).count() == 1
    archived = db.query(RawPost).one()
    assert archived.body == "Actually the combat is broken"
    assert archived.relevance_tier == "noise"
    assert archived.is_off_topic_drift is True
    assert db.query(SentimentRecord).count() == 0


def test_old_tombstone_does_not_delete_reappeared_comment(db, game, configured):
    item = comment(game)
    tomb = {"comment_id": "c1", "steam_app_id": str(game.steam_app_id), "deleted_at": stamp(-2)}
    import_game_comments(db, game, get=getter(payload([item], [tomb])))
    assert db.query(RawPost).count() == 1


def test_budget_persists_cursor_and_unlimited_retains_old_text(db, game, configured):
    old = comment(game, fetched=stamp(-400))
    old["publishedAt"] = stamp(-410)
    snapshot = stamp()
    token = old["fetchedAt"] + "|c1"
    result = import_game_comments(db, game, get=getter(payload([old], next_cursor=token, snapshot=snapshot)), max_pages=1)
    assert result["complete"] is False
    assert json.loads(cursor_row(db, game).value)["cursor"] == token
    assert db.query(RawPost).count() == 1
    import_game_comments(db, game, get=getter(payload([], snapshot=snapshot, mode="policy30")))
    assert db.query(RawPost).count() == 1  # even a producer policy30 flag cannot erase stored text


def test_classifier_uses_comment_only_and_flags_solicitation(db, game, configured):
    import_game_comments(db, game, get=getter(payload([
        comment(game), comment(game, "spam", "DM me on telegram for guaranteed profit"),
    ])))
    fake = dict(label="positive", score=.9, signal_quality="high", language="en", applied_rules=[])
    with patch("services.ingestor.classify_batch_with_gate_v2", return_value=[fake.copy(), fake.copy()]) as classify:
        errors = []
        _step5_classify_sentiment(db, game, [], errors)
        db.commit()
    assert errors == []
    assert all(x["title"] == "" for x in classify.call_args.args[0])
    assert db.query(SentimentRecord).count() == 2
    spam = db.query(RawPost).filter_by(external_id="youtube:spam").one()
    assert spam.is_off_topic_drift is True
    assert spam.sentiment_record.sentiment == SentimentEnum.neutral
