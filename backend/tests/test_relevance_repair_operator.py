import gzip
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import sessionmaker

from models import Game, Publisher, RawPost, SourceEnum, DailySummary
from scripts.repair_game_relevance import run


def http_idle(running=False):
    return SimpleNamespace(get=lambda *a,**kw: SimpleNamespace(
        raise_for_status=lambda:None,json=lambda:{"is_running":running}))


def test_operator_defaults_readonly_and_requires_exact_hash(db, tmp_path):
    publisher=Publisher(name="Test")
    db.add(publisher)
    db.flush()
    game=Game(name="Rideshare Stimulator",publisher_id=publisher.id,steam_app_id=1,
              distinctive_keywords=["rideshare stimulator"])
    db.add(game)
    db.flush()
    row=RawPost(game_id=game.id,source=SourceEnum.reddit,external_id="bad",
                url="https://www.reddit.com/r/gamesuggestions/comments/bad/",
                body="Bioshock recommendations",relevance_tier="dedicated_sub",
                is_relevant=True,is_off_topic_drift=False)
    db.add(row)
    db.commit()
    gid,rid=game.id,row.id
    db.rollback()
    factory=sessionmaker(bind=db.get_bind())
    dry=run(gid,http=http_idle(),session_factory=factory)
    assert not dry["applied"] and dry["rows_quarantined"]==1
    assert not list(tmp_path.iterdir())
    with pytest.raises(ValueError,match="hash"):
        run(gid,apply=True,expected_sha256="wrong",http=http_idle(),
            session_factory=factory,audit_directory=tmp_path)
    assert not list(tmp_path.iterdir())
    applied=run(gid,apply=True,expected_sha256=dry["plan_sha256"],
                http=http_idle(),session_factory=factory,audit_directory=tmp_path)
    assert applied["applied"]
    with gzip.open(applied["audit_file"],"rt") as f:
        audit=json.load(f)
    assert audit["plan"]["patches"][0]["before"]["relevance_tier"]=="dedicated_sub"
    assert audit["plan"]["patches"][0]["after"]["relevance_tier"]=="noise"
    db.expire_all()
    assert db.get(RawPost,rid).is_off_topic_drift is True
    assert db.query(RawPost).count()==1


def test_operator_refuses_running_ingestion():
    with pytest.raises(RuntimeError,match="active"):
        run(144,http=http_idle(True))


def test_offline_mode_requires_fully_stopped_service(monkeypatch):
    monkeypatch.setattr("scripts.repair_game_relevance.subprocess.check_output",
                        lambda *a,**kw:"active")
    with pytest.raises(RuntimeError,match="stopped"):
        run(144,offline_maintenance=True)
