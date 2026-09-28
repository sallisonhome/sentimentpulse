from datetime import date, datetime

import pytest

from models import Game, Publisher, RawPost, SentimentRecord, SentimentEnum, SourceEnum
from services.reddit_community_rules import GENERIC_DISCUSSION_SUBS
from services.relevance_repair import plan_repair, apply_plan
from services.relevance_tagger import tag_post
from services.period_summary_service import _sample_posts_with_ids, _sample_posts_for_window


@pytest.mark.parametrize("sub", sorted(GENERIC_DISCUSSION_SUBS))
def test_generic_community_never_auto_admits_unrelated_games(sub):
    kwargs = dict(source=SourceEnum.reddit, url=f"https://www.reddit.com/r/{sub}/comments/abc/",
                  keywords=["rideshare stimulator", "rideshare game"])
    assert tag_post(title="What game should I play?", body="Bioshock or Slay the Spire?", **kwargs)[0] == "noise"
    assert tag_post(title="Rideshare: Stimulator impressions", body="Driving looks fun.", **kwargs)[0] == "signal"


@pytest.fixture
def corpus(db):
    publisher = Publisher(name="Test")
    db.add(publisher)
    db.flush()
    game = Game(name='Rideshare "Stimulator"', steam_app_id=1, publisher_id=publisher.id,
                distinctive_keywords=["rideshare stimulator", "rideshare game"])
    other = Game(name="Other game", steam_app_id=2, publisher_id=publisher.id)
    db.add_all([game, other])
    db.flush()
    def add(external_id, body, *, source=SourceEnum.reddit, parent=None, gid=None,
            sub="gamesuggestions", drift=False, tier="dedicated_sub", relevant=True):
        row = RawPost(
            game_id=gid or game.id, source=source, external_id=external_id,
            title="", body=body, url=f"https://www.reddit.com/r/{sub}/comments/{parent or external_id}/{external_id}/",
            parent_external_id=parent, relevance_tier=tier, matched_keywords=[],
            is_relevant=relevant, is_off_topic_drift=drift,
            post_date=datetime(2026,9,25), upvotes=100)
        db.add(row)
        db.flush()
        db.add(SentimentRecord(raw_post_id=row.id,sentiment=SentimentEnum.positive,sentiment_score=0.9))
        return row
    bad = add("bad", "Recommend an atmospheric shooter, not a driving game.")
    child = add("child", "Kingdoms of Amalur Re Reckoning. Classic WoW vibes.", source=SourceEnum.reddit_comment, parent="bad")
    orphan = add("orphan", "Bioshock and Slay the Spire are my top recommendations.", source=SourceEnum.reddit_comment, parent="missing")
    good = add("good", "Rideshare Stimulator looks like a genuinely fun driving game.")
    good_child = add("goodchild", "I love the handling in this gameplay trailer.", source=SourceEnum.reddit_comment, parent="good")
    explicit = add("explicit", "Rideshare Stimulator driving reminds me of GTA.", source=SourceEnum.reddit_comment, parent="bad")
    other_row = add("other", "Bioshock is relevant to a different game.", gid=other.id)
    untouched = add("dedicated", "Love this specific game's driving.", sub="verifieddedicated")
    drift = add("drift", "This already flagged hardware complaint must never enter the digest.", sub="verifieddedicated", drift=True)
    db.commit()
    return game, [bad,child,orphan], [good,good_child,explicit], other_row, untouched, drift, add


def test_plan_is_read_only_scoped_and_preserves_real_mentions(db, corpus):
    game,bad,good,other,untouched,drift,_ = corpus
    plan = plan_repair(db, game.id)
    quarantined = {p["id"] for p in plan["patches"] if p["after"]["relevance_tier"]=="noise"}
    assert quarantined == {r.id for r in bad}
    assert not quarantined.intersection({r.id for r in good})
    assert other.id not in {p["id"] for p in plan["patches"]}
    assert untouched.id not in {p["id"] for p in plan["patches"]}
    assert bad[0].relevance_tier == "dedicated_sub"
    assert plan["plan_sha256"] == plan_repair(db,game.id)["plan_sha256"]


def test_apply_is_idempotent_keeps_raw_and_classifications_and_closes_sample_gate(db, corpus):
    game,bad,good,other,untouched,drift,_ = corpus
    before_raw = db.query(RawPost).count()
    before_sentiment = db.query(SentimentRecord).count()
    plan = plan_repair(db, game.id)
    apply_plan(db, plan, expected_sha256=plan["plan_sha256"])
    db.commit()
    db.expire_all()
    assert db.query(RawPost).count() == before_raw
    assert db.query(SentimentRecord).count() == before_sentiment
    assert all(db.get(RawPost,r.id).is_off_topic_drift for r in bad)
    assert plan_repair(db,game.id)["rows_changed"] == 0
    ids = _sample_posts_with_ids(db,game.id,date(2026,9,21),date(2026,9,27))
    allowed = {p["id"] for group in ids.values() for p in group}
    assert not allowed.intersection({r.id for r in bad} | {drift.id})
    assert all(r.id in allowed for r in good)
    text = str(_sample_posts_for_window(db,game.id,date(2026,9,21),date(2026,9,27)))
    assert "Bioshock" not in text and "Slay the Spire" not in text and "Amalur" not in text
    assert "GTA" in text  # Do not blacklist legitimate comparisons.


def test_apply_refuses_changed_or_unapproved_plan(db, corpus):
    game,_,_,_,_,_,add = corpus
    plan = plan_repair(db,game.id)
    with pytest.raises(ValueError,match="review"):
        apply_plan(db,plan,expected_sha256="wrong")
    add("newbad", "Another unrelated game suggestion without the target title.")
    db.commit()
    with pytest.raises(ValueError,match="review"):
        apply_plan(db,plan,expected_sha256=plan["plan_sha256"])


@pytest.mark.parametrize("flags", [
    {"tier":"noise"}, {"drift":True}, {"relevant":False},
])
def test_both_summary_samplers_reject_ineligible_rows(db, corpus, flags):
    game,_,_,_,_,_,add = corpus
    row = add("poison", "High-vote unrelated evidence must not reach any summary prompt.", **flags)
    row.upvotes = 100000
    db.commit()
    sampled = _sample_posts_with_ids(db,game.id,date(2026,9,21),date(2026,9,27))
    assert row.id not in {p["id"] for group in sampled.values() for p in group}
    plain = _sample_posts_for_window(db,game.id,date(2026,9,21),date(2026,9,27))
    assert "High-vote unrelated" not in str(plain)
