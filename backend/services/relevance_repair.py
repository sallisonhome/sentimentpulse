"""Plan/apply an explicit, audit-backed correction of broad-community tags.

No raw posts or sentiment records are deleted. Only one requested game's rows
from the supplied broad communities and their linked replies are eligible.
"""
import hashlib
import json

from models import Game, RawPost, SourceEnum
from services.reddit_community_rules import GENERIC_DISCUSSION_SUBS
from services.relevance_tagger import _extract_subreddit, build_keywords_for_game, tag_post

AUDIT_FIELDS = ("relevance_tier", "matched_keywords", "is_relevant", "is_off_topic_drift")


def _state(row):
    return {k: getattr(row, k) for k in AUDIT_FIELDS}


def plan_repair(db, game_id):
    game = db.get(Game, game_id)
    if game is None:
        raise ValueError("Game not found")
    keywords = build_keywords_for_game(game)
    parents = {}
    patches = []
    retained = 0
    for row in db.query(RawPost).filter(
        RawPost.game_id == game_id, RawPost.source == SourceEnum.reddit,
    ).order_by(RawPost.id).yield_per(500):
        if _extract_subreddit(row.url) not in GENERIC_DISCUSSION_SUBS:
            continue
        tier, matched = tag_post(source=SourceEnum.reddit, url=row.url,
                                 title=row.title, body=row.body, keywords=keywords)
        parents[row.external_id] = (tier, matched)
        before = _state(row)
        after = {**before, "relevance_tier": tier, "matched_keywords": matched}
        if tier == "noise":
            after.update(is_relevant=False, is_off_topic_drift=True)
        else:
            retained += 1
        if before != after:
            patches.append({"id":row.id, "source":row.source.value, "before":before, "after":after})
    for row in db.query(RawPost).filter(
        RawPost.game_id == game_id, RawPost.source == SourceEnum.reddit_comment,
    ).order_by(RawPost.id).yield_per(500):
        if (_extract_subreddit(row.url) not in GENERIC_DISCUSSION_SUBS
                and row.parent_external_id not in parents):
            continue
        own_tier, own_matches = tag_post(source=SourceEnum.reddit, url=row.url,
                                         title=row.title, body=row.body, keywords=keywords)
        parent_tier, parent_matches = parents.get(row.parent_external_id, ("noise", []))
        # A real game mention can stand on its own, even in an unrelated thread.
        tier, matched = (("signal", own_matches) if own_matches else (parent_tier, parent_matches))
        before = _state(row)
        after = {**before, "relevance_tier":tier, "matched_keywords":list(matched)}
        if tier == "noise":
            after.update(is_relevant=False, is_off_topic_drift=True)
        else:
            retained += 1
        if before != after:
            patches.append({"id":row.id, "source":row.source.value, "before":before, "after":after})
    patches.sort(key=lambda p:p["id"])
    digest = hashlib.sha256(json.dumps(
        {"game_id":game_id,"patches":patches},sort_keys=True,separators=(",",":")
    ).encode()).hexdigest()
    return {"game_id":game_id, "game_name":game.name, "plan_sha256":digest,
            "rows_changed":len(patches),
            "rows_quarantined":sum(p["after"]["relevance_tier"]=="noise" for p in patches),
            "retained_on_topic_rows":retained, "patches":patches}


def apply_plan(db, plan, *, expected_sha256):
    """Caller must save the complete audit BEFORE calling, and commit afterward."""
    current = plan_repair(db, plan["game_id"])
    if expected_sha256 != plan["plan_sha256"] or current["plan_sha256"] != expected_sha256:
        raise ValueError("Repair plan changed; a new dry-run review is required")
    for patch in plan["patches"]:
        changed = db.query(RawPost).filter(
            RawPost.id == patch["id"], RawPost.game_id == plan["game_id"]
        ).update(patch["after"], synchronize_session=False)
        if changed != 1:
            raise RuntimeError("Scoped row disappeared during repair")
    db.flush()
