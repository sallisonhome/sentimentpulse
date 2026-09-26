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
    next_get = getter(payload([comment(game, "c2")], snapshot=snapshot),
                      payload([], snapshot=stamp()))
    import_game_comments(db, game, get=next_get)
    assert next_get.call_args_list[0].kwargs["params"]["cursor"] == token
    assert next_get.call_args_list[0].kwargs["params"]["until"] == snapshot
    assert "until" not in next_get.call_args_list[1].kwargs["params"]
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
    import_game_comments(db, game, get=getter(
        payload([], snapshot=snapshot, mode="policy30"), payload([])))
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


def resume_state(db, game, snapshot="2026-09-25T13:14:30.000Z"):
    key = f"youtube_feed_cursor:{game.id}:{game.steam_app_id}"
    db.add(AppSetting(key=key, value=json.dumps({
        "since": "2026-09-24T00:00:00.000Z", "until": snapshot,
        "cursor": "2026-09-25T08:30:00.000Z|old",
        "deletedSince": "2026-09-24T00:00:00.000Z",
    })))
    db.commit()
    return snapshot


def test_resume_old_snapshot_then_import_today_in_same_call(db, game, configured):
    old = resume_state(db, game)
    current = "2026-09-26T10:00:00.000Z"
    fresh = comment(game, "today", fetched="2026-09-26T08:31:25.000Z")
    fresh["publishedAt"] = "2026-09-26T01:00:00.000Z"
    get = getter(payload([], snapshot=old), payload([fresh], snapshot=current))
    result = import_game_comments(db, game, get=get)
    assert result["complete"] and result["snapshots_completed"] == 2
    assert result["completed_through"] == current
    assert result["stop_reason"] == "current_snapshot_complete"
    second = get.call_args_list[1].kwargs["params"]
    assert "cursor" not in second and "until" not in second
    assert second["since"] == second["deletedSince"] == "2026-09-25T13:14:29.000Z"
    assert db.query(RawPost).one().post_date == datetime(2026, 9, 26, 1)
    assert json.loads(cursor_row(db, game).value)["since"] == "2026-09-26T09:59:59.000Z"


def test_budget_at_old_snapshot_boundary_is_not_complete(db, game, configured):
    old = resume_state(db, game)
    result = import_game_comments(db, game, get=getter(payload([], snapshot=old)), max_pages=1)
    assert not result["complete"]
    assert result["stop_reason"] == "page_budget"
    assert result["snapshots_completed"] == 1
    state = json.loads(cursor_row(db, game).value)
    assert "cursor" not in state and "until" not in state
    assert state["since"] == "2026-09-25T13:14:29.000Z"


def test_fresh_request_failure_keeps_completed_old_checkpoint(db, game, configured):
    old = resume_state(db, game)
    get = Mock(side_effect=[
        Mock(status_code=200, json=lambda: payload([], snapshot=old)),
        Mock(status_code=503),
    ])
    with pytest.raises(RuntimeError, match="503"):
        import_game_comments(db, game, get=get)
    state = json.loads(cursor_row(db, game).value)
    assert state["since"] == "2026-09-25T13:14:29.000Z"
    assert "cursor" not in state
    followup = getter(payload([], snapshot="2026-09-26T10:00:00.000Z"))
    assert import_game_comments(db, game, get=followup)["complete"]


def test_time_budget_checkpoints_last_successful_page(db, game, configured, monkeypatch):
    import services.youtube_service as service
    monkeypatch.setattr(service.time, "monotonic", Mock(side_effect=[0, 0, 6]))
    snapshot = stamp()
    token = comment(game)["fetchedAt"] + "|c1"
    result = import_game_comments(db, game, get=getter(
        payload([comment(game)], next_cursor=token, snapshot=snapshot)), max_seconds=5)
    assert not result["complete"] and result["stop_reason"] == "time_budget"
    assert result["pages"] == 1
    assert json.loads(cursor_row(db, game).value)["cursor"] == token


def test_targeted_classification_leaves_other_sources_unprocessed(db, game, configured):
    import_game_comments(db, game, get=getter(payload([comment(game)])))
    other = RawPost(game_id=game.id, source=SourceEnum.steam_review,
                    external_id="untouched-steam", body="Great combat", is_relevant=None)
    db.add(other); db.commit()
    fake = dict(label="positive", score=.9, signal_quality="high", language="en", applied_rules=[])
    with patch("services.ingestor.classify_batch_with_gate_v2", return_value=[fake]):
        _step5_classify_sentiment(db, game, [], [], source_filter=SourceEnum.youtube_comment)
    assert db.query(SentimentRecord).count() == 1
    assert other.is_relevant is None


def test_default_budget_can_finish_more_than_ten_pages(db, game, configured):
    snapshot = stamp()
    pages = []
    for i in range(12):
        item = comment(game, cid=f"large-{i}")
        token = item["fetchedAt"] + f"|large-{i}" if i < 11 else None
        pages.append(payload([item], next_cursor=token, snapshot=snapshot))
    result = import_game_comments(db, game, get=getter(*pages))
    assert result["complete"] and result["pages"] == 12
    assert db.query(RawPost).count() == 12
