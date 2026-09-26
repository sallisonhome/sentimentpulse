from unittest.mock import MagicMock, Mock
import pytest

from models import AppSetting, SourceEnum
from scripts import catchup_youtube as job


@pytest.fixture
def environment(db, monkeypatch):
    http = MagicMock()
    http.get.return_value.json.return_value = {"is_running": False}
    http.post.return_value.text = '{"status":"started"}'
    http.__enter__.return_value = http
    monkeypatch.setattr(job.requests, "Session", lambda: http)
    monkeypatch.setattr(job, "SessionLocal", lambda: db)
    db.add(AppSetting(key="youtube_import_enabled", value="true"))
    db.commit()
    importer = Mock(return_value={"complete": True})
    classify = Mock()
    monkeypatch.setattr(job, "import_game_comments", importer)
    monkeypatch.setattr(job, "_step5_classify_sentiment", classify)
    monkeypatch.setattr(job, "_step6_extract_topics", Mock())
    monkeypatch.setattr(job, "_step7_daily_summary", Mock())
    return http, importer, classify


def test_only_requested_active_title_and_youtube_classifier(game, environment):
    http, importer, classify = environment
    result = job.run([game.id], max_pages=200, max_seconds=180)
    assert [r["game_id"] for r in result] == [game.id]
    importer.assert_called_once()
    assert importer.call_args.args[1].id == game.id
    assert classify.call_args.kwargs["source_filter"] == SourceEnum.youtube_comment
    assert http.post.call_args.kwargs["params"]["game_ids"] == str(game.id)
    assert http.post.call_count == 2


def test_busy_ingestion_prevents_any_import(game, environment):
    http, importer, _ = environment
    http.get.return_value.json.return_value = {"is_running": True}
    with pytest.raises(RuntimeError, match="active or unknown"):
        job.run([game.id])
    importer.assert_not_called()
    http.post.assert_not_called()


def test_invalid_target_prevents_any_import(game, environment):
    http, importer, _ = environment
    with pytest.raises(ValueError, match="active"):
        job.run([game.id + 1000])
    importer.assert_not_called()
    http.post.assert_not_called()


def test_partial_catchup_does_not_claim_success(game, environment):
    http, importer, _ = environment
    importer.return_value = {"complete": False}
    with pytest.raises(RuntimeError, match="partial"):
        job.run([game.id])
    assert http.post.call_count == 2  # available committed data still refreshes
