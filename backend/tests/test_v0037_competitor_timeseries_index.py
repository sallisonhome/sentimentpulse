"""2026-10-17: Post Volume by Title must count the same days, faster.

The competitor-timeseries query filtered on date(post_date), which stops
SQLite from using ix_raw_posts_game_id_post_date for the date range. Right
after the daily ingest Hellraiser's group took 9-26 s and the card rendered
nothing while it waited. The filter now compares the bare column to a
'YYYY-MM-DD' text literal. These tests pin that the day boundaries are
identical for every stored post_date format and that the index is used.
"""
from datetime import date, timedelta
from unittest.mock import patch

from sqlalchemy import text


def _competitor(client, parent_id, app_id, name):
    with patch("services.steam_service.get_app_details", return_value={
        "name": name, "steam_appid": app_id,
        "release_date": {"coming_soon": False, "date": "1 Jan, 2024"}}):
        r = client.post(f"/api/games/{parent_id}/competitors", json={"steam_app_id": app_id})
    assert r.status_code == 201
    return r.json()["id"]


def _insert(db, game_id, ext, post_date_text):
    """Insert with the exact stored text so mixed historical formats are covered."""
    db.execute(text(
        "INSERT INTO raw_posts (game_id, source, external_id, author, body, url, upvotes, "
        "collected_at, post_date) VALUES (:g, 'steam_review', :e, 'x', 'b', 'u', 0, :d, :d)"),
        {"g": game_id, "e": ext, "d": post_date_text})
    pid = db.execute(text("SELECT id FROM raw_posts WHERE external_id=:e"), {"e": ext}).scalar()
    db.execute(text(
        "INSERT INTO sentiment_records (raw_post_id, sentiment, sentiment_score, topics) "
        "VALUES (:p, 'positive', 0.9, '[]')"), {"p": pid})
    db.commit()


def _reference_counts(db, game_ids, start: date):
    """The pre-change semantics: date(post_date) >= start."""
    rows = db.execute(text(
        "SELECT date(r.post_date) AS day, r.game_id, count(r.id) FROM raw_posts r "
        "JOIN sentiment_records s ON s.raw_post_id = r.id "
        f"WHERE r.game_id IN ({','.join(str(g) for g in game_ids)}) "
        "AND r.post_date IS NOT NULL AND date(r.post_date) >= :s "
        "GROUP BY day, r.game_id"), {"s": start.isoformat()}).all()
    return {(str(d), g): c for d, g, c in rows}


def test_day_boundaries_match_date_function_for_all_stored_formats(client, db, game):
    from routers.dashboard import _period_start
    from schemas import PeriodEnum

    comp = _competitor(client, game.id, 810001, "Boundary Rival")
    start = _period_start(PeriodEnum.weekly)
    before = start - timedelta(days=1)
    fmt = [
        f"{before.isoformat()} 23:59:59.999999",   # just outside
        f"{before.isoformat()}T23:59:59",           # just outside, T separator
        f"{start.isoformat()} 00:00:00",            # midnight, no microseconds
        f"{start.isoformat()} 00:00:00.000000",     # midnight with microseconds
        f"{start.isoformat()}T00:00:01",            # T separator
        f"{start.isoformat()} 12:30:00.123456",
        f"{(start + timedelta(days=3)).isoformat()} 08:00:00",
    ]
    for i, d in enumerate(fmt):
        _insert(db, game.id, f"p{i}", d)
        _insert(db, comp, f"c{i}", d)

    body = client.get(f"/api/games/{game.id}/competitor-timeseries?period=weekly").json()
    got = {}
    for day in body["timeseries"]:
        for gid, cnt in day["counts"].items():
            if cnt:
                got[(day["day"], int(gid))] = cnt
    assert got == _reference_counts(db, [game.id, comp], start)
    # 5 in-window rows per title: both midnight forms and the T form count.
    assert sum(c for (d, g), c in got.items() if g == game.id) == 5
    assert (start.isoformat(), game.id) in got and got[(start.isoformat(), game.id)] == 4


def test_period_over_period_totals_match_date_function(client, db, game):
    comp = _competitor(client, game.id, 810002, "Window Rival")
    today = date.today()
    curr_start = today - timedelta(days=6)
    prev_start = curr_start - timedelta(days=7)
    stamps = [
        f"{(prev_start - timedelta(days=1)).isoformat()} 23:59:59",  # outside both
        f"{prev_start.isoformat()} 00:00:00",                         # prev, midnight
        f"{(curr_start - timedelta(days=1)).isoformat()}T23:59:59",   # prev, last second
        f"{curr_start.isoformat()} 00:00:00",                         # curr, midnight
        f"{today.isoformat()} 23:59:59.999999",                       # curr, last instant
    ]
    for i, d in enumerate(stamps):
        _insert(db, comp, f"w{i}", d)
    # Two more prior-window days so the existing >=3-day coverage rule
    # keeps prev_totals (that rule is unchanged by this fix).
    for k, off in enumerate((2, 4)):
        _insert(db, game.id, f"cov{k}", f"{(prev_start + timedelta(days=off)).isoformat()} 10:00:00")
    g = {x["game_id"]: x for x in client.get(
        f"/api/games/{game.id}/competitor-timeseries?period=weekly").json()["games"]}
    assert g[comp]["current_total"] == 2
    assert g[comp]["prev_total"] == 2
    assert g[game.id]["prev_total"] == 2 and g[game.id]["current_total"] == 0


def _plan(db, drift_filter, game_ids):
    from sqlalchemy import func
    from models import RawPost, SentimentRecord
    from routers.dashboard import _day_start

    q = (db.query(func.date(RawPost.post_date), RawPost.game_id, func.count(RawPost.id))
         .join(SentimentRecord, SentimentRecord.raw_post_id == RawPost.id)
         .filter(RawPost.game_id.in_(game_ids))
         .filter(RawPost.post_date.isnot(None))
         .filter(drift_filter)
         .filter(RawPost.post_date >= _day_start(date(2026, 10, 11)))
         .group_by(func.date(RawPost.post_date), RawPost.game_id))
    compiled = q.statement.compile(compile_kwargs={"literal_binds": True})
    return " ".join(str(r[-1]) for r in db.execute(text(f"EXPLAIN QUERY PLAN {compiled}")).all())


def test_multi_title_query_uses_the_game_date_index(db):
    """Production 2026-10-17: for a 4-5 title group SQLite chose
    ix_raw_posts_is_off_topic_drift and scanned ~all of raw_posts (14 s per
    query). The unindexable drift predicate forces the composite index."""
    from routers.dashboard import _NOT_DRIFT_UNINDEXED
    for ids in ([1, 2], [23, 145, 146, 161], [21, 138, 139, 140, 159]):
        plan = _plan(db, _NOT_DRIFT_UNINDEXED, ids)
        assert "ix_raw_posts_game_id_post_date" in plan, plan
        assert "is_off_topic_drift" not in plan, plan


def test_unindexed_drift_filter_matches_the_original_predicate(client, db, game):
    """Same rows as is_off_topic_drift IS 0 (the column is NOT NULL)."""
    from models import RawPost
    from routers.dashboard import _NOT_DRIFT, _NOT_DRIFT_UNINDEXED
    comp = _competitor(client, game.id, 810003, "Drift Rival")
    today = date.today().isoformat()
    for i in range(4):
        _insert(db, comp, f"d{i}", f"{today} 10:00:0{i}")
    db.execute(text("UPDATE raw_posts SET is_off_topic_drift = 1 WHERE external_id IN ('d1','d3')"))
    db.commit()
    a = {r.id for r in db.query(RawPost).filter(_NOT_DRIFT).all()}
    b = {r.id for r in db.query(RawPost).filter(_NOT_DRIFT_UNINDEXED).all()}
    assert a == b and len(a) == 2


# ── Regression guards (2026-10-17) ───────────────────────────────────────────
# The fix above is easy to undo by copy-pasting the date(post_date) pattern
# from neighbouring queries. These guards fail CI if that happens.

import inspect
import re
from pathlib import Path

_DATE_FILTER = re.compile(r"\.filter\(\s*func\.date\(\s*(RawPost\.post_date|effective_date_expr)\s*\)")

# Existing uses elsewhere, frozen as of 2026-10-17. New code must not add
# more; converting one to the index-friendly form is encouraged — lower the
# number here in the same change.
_BASELINE = {
    "routers/dashboard.py": 7,
    "routers/ingest.py": 4,
    "services/ingestor.py": 2,
    "services/dashboard_feedback_synthesizer.py": 1,
}


def test_post_volume_by_title_never_filters_on_date_of_post_date():
    from routers import dashboard
    src = inspect.getsource(dashboard.get_competitor_timeseries)
    assert not _DATE_FILTER.search(src), (
        "competitor-timeseries must filter on the bare RawPost.post_date column "
        "(use _day_start); date(post_date) disables the (game_id, post_date) index "
        "and made the chart disappear after the daily ingest (lessons 2026-10-17).")
    assert "_day_start(" in src
    assert ".filter(_NOT_DRIFT)" not in src, (
        "competitor-timeseries must use _NOT_DRIFT_UNINDEXED: the indexable drift "
        "predicate lets SQLite pick ix_raw_posts_is_off_topic_drift for multi-title "
        "groups and scan all of raw_posts (lessons 2026-10-17).")
    assert src.count("_NOT_DRIFT_UNINDEXED") >= 3


def test_no_new_date_of_post_date_range_filters_anywhere():
    root = Path(__file__).resolve().parents[1]
    found = {}
    for path in list((root / "routers").glob("*.py")) + list((root / "services").glob("*.py")):
        n = len(_DATE_FILTER.findall(path.read_text(encoding="utf-8")))
        if n:
            found[str(path.relative_to(root))] = n
    grown = {f: (n, _BASELINE.get(f, 0)) for f, n in found.items() if n > _BASELINE.get(f, 0)}
    assert not grown, (
        f"New date(post_date) range filters (found, allowed): {grown}. Compare the bare "
        "column to routers.dashboard._day_start(...) instead so the index is used.")
