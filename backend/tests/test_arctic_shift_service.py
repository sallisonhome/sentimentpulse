"""
Tests for arctic_shift_service.py

All HTTP calls are mocked with requests_mock so tests run offline and fast.
Arctic Shift response shape: {"data": [post1, post2, ...]}
Each post is a Reddit-API-format dict:
    id, author, title, selftext, permalink, score, created_utc, + more fields.
"""
import time
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
import requests_mock as requests_mock_module

from services.arctic_shift_service import (
    ARCTIC_SHIFT_BASE,
    ARCTIC_SHIFT_GENERAL_SUBS,
    fetch_arctic_shift_subreddit_posts,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_post(
    post_id: str = "abc123",
    author: str = "testuser",
    title: str = "Test Post",
    selftext: str = "Post body here",
    permalink: str = "/r/testgame/comments/abc123/test_post/",
    score: int = 42,
    created_utc: float = 1_700_000_000.0,
) -> dict:
    """Build a minimal Arctic Shift / Reddit-format post dict."""
    return {
        "id": post_id,
        "author": author,
        "title": title,
        "selftext": selftext,
        "permalink": permalink,
        "score": score,
        "created_utc": created_utc,
        "subreddit": "testgame",
        "url": f"https://www.reddit.com{permalink}",
        "num_comments": 5,
        "is_self": True,
    }


def _arctic_ok(posts: list[dict]) -> dict:
    """Build a well-formed Arctic Shift success response."""
    return {"data": posts}


# Silence the inter-request sleep in all tests for speed
@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr(time, "sleep", lambda _: None)


# ── Test 1: Game-specific sub — one request, expected keys ───────────────────

def test_game_specific_sub_one_request_returns_expected_keys():
    """
    A dedicated game subreddit (is_general_sub=False) should issue exactly
    ONE request and return post dicts with all required keys.
    """
    post = _make_post(
        post_id="post1",
        title="Space Marine 2 is amazing",
        selftext="Loved every mission",
        permalink="/r/Spacemarine/comments/post1/space_marine_2/",
        score=100,
        created_utc=1_700_000_000.0,
    )

    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, json=_arctic_ok([post]))
        results = fetch_arctic_shift_subreddit_posts(
            "Spacemarine", limit=5, game_name="", is_general_sub=False
        )

    assert len(results) == 1
    assert m.call_count == 1, "Expected exactly one HTTP request for a game-specific sub"

    r = results[0]
    for key in ("external_id", "author", "title", "body", "url", "upvotes", "post_date"):
        assert key in r, f"Missing key: {key}"

    assert r["external_id"] == "post1"
    assert r["upvotes"] == 100
    assert r["url"] == "https://www.reddit.com/r/Spacemarine/comments/post1/space_marine_2/"


# ── Test 2: General sub — two requests issued, results merged & deduped ───────

def test_general_sub_with_game_name_two_requests_merged():
    """
    For a general sub with a game_name, TWO requests should be issued
    (title search and selftext search), and results should be merged and
    deduped by id.  Posts that don't mention the game are filtered out.
    """
    post_title_only = _make_post(
        post_id="t1",
        title="Warhammer Space Marine 2 thoughts",
        selftext="Great game overall",
        score=10,
    )
    post_selftext_only = _make_post(
        post_id="s1",
        title="Weekend gaming",
        selftext="Playing Warhammer Space Marine 2 all weekend",
        score=5,
    )
    # This post appears in BOTH responses (same id) — should be deduped
    post_both = _make_post(
        post_id="b1",
        title="My Warhammer experience",
        selftext="Space Marine combat is incredible",
        score=20,
    )
    # This post should be filtered: doesn't mention "Warhammer" or "Marine"
    post_irrelevant = _make_post(
        post_id="irr1",
        title="Unrelated post",
        selftext="Nothing about the game",
        score=1,
    )

    responses = [
        # title search response
        _arctic_ok([post_title_only, post_both, post_irrelevant]),
        # selftext search response
        _arctic_ok([post_selftext_only, post_both]),
    ]

    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, [{"json": r} for r in responses])
        results = fetch_arctic_shift_subreddit_posts(
            "gaming",
            limit=100,
            game_name="Warhammer 40,000: Space Marine 2",
            is_general_sub=True,
        )

    assert m.call_count == 2, "Expected exactly two HTTP requests for a general sub"
    ids = {r["external_id"] for r in results}
    # post_both appears once even though it was in both responses
    assert "b1" in ids
    assert "t1" in ids
    assert "s1" in ids
    # Irrelevant post should be filtered
    assert "irr1" not in ids


# ── Test 3: General sub WITHOUT game_name — behaves like game-specific sub ────

def test_general_sub_without_game_name_single_request():
    """
    If is_general_sub=True but game_name is empty, only ONE request is issued
    (no keyword search needed).
    """
    post = _make_post(post_id="g1", title="Any post")

    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, json=_arctic_ok([post]))
        results = fetch_arctic_shift_subreddit_posts(
            "gaming", limit=50, game_name="", is_general_sub=True
        )

    assert m.call_count == 1
    assert len(results) == 1
    assert results[0]["external_id"] == "g1"


# ── Test 4: HTTP 503 returns empty list without raising ────────────────────────

def test_http_503_returns_empty_list():
    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, status_code=503)
        results = fetch_arctic_shift_subreddit_posts(
            "Spacemarine", limit=10, game_name="", is_general_sub=False
        )
    assert results == []


# ── Test 5: HTTP 502 returns empty list without raising ────────────────────────

def test_http_502_returns_empty_list():
    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, status_code=502)
        results = fetch_arctic_shift_subreddit_posts(
            "gaming", limit=10, game_name="", is_general_sub=False
        )
    assert results == []


# ── Test 6: HTTP 429 (rate limit) returns empty list without raising ───────────

def test_http_429_returns_empty_list():
    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, status_code=429)
        results = fetch_arctic_shift_subreddit_posts(
            "gaming", limit=10, game_name="", is_general_sub=False
        )
    assert results == []


# ── Test 7: Connection timeout returns empty list without raising ──────────────

def test_connection_timeout_returns_empty_list():
    import requests.exceptions

    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, exc=requests.exceptions.Timeout("timed out"))
        results = fetch_arctic_shift_subreddit_posts(
            "Spacemarine", limit=10, game_name="", is_general_sub=False
        )
    assert results == []


# ── Test 8: Response with empty data array returns empty list ─────────────────

def test_empty_data_array_returns_empty_list():
    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, json={"data": []})
        results = fetch_arctic_shift_subreddit_posts(
            "Spacemarine", limit=10, game_name="", is_general_sub=False
        )
    assert results == []


# ── Test 9: Response with error field returns empty list ──────────────────────

def test_error_field_returns_empty_list(caplog):
    """API returning {"error": "..."} should return empty list and log a warning."""
    import logging

    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, json={"error": "invalid subreddit"})
        with caplog.at_level(logging.WARNING, logger="services.arctic_shift_service"):
            results = fetch_arctic_shift_subreddit_posts(
                "Spacemarine", limit=10, game_name="", is_general_sub=False
            )
    assert results == []
    assert any("error" in rec.message.lower() for rec in caplog.records)


# ── Test 10: Malformed / non-JSON response returns empty list ─────────────────

def test_malformed_json_returns_empty_list():
    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, text="<html>Not JSON</html>", status_code=200)
        results = fetch_arctic_shift_subreddit_posts(
            "Spacemarine", limit=10, game_name="", is_general_sub=False
        )
    assert results == []


# ── Test 11: Post with missing selftext → body is empty string ────────────────

def test_missing_selftext_body_is_empty_string():
    post = _make_post(post_id="ns1")
    del post["selftext"]  # field absent entirely

    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, json=_arctic_ok([post]))
        results = fetch_arctic_shift_subreddit_posts(
            "Spacemarine", limit=10, game_name="", is_general_sub=False
        )

    assert len(results) == 1
    assert results[0]["body"] == ""


# ── Test 12: Very long selftext is truncated to 2000 chars ────────────────────

def test_long_selftext_truncated_to_2000_chars():
    long_body = "x" * 5000
    post = _make_post(post_id="lg1", selftext=long_body)

    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, json=_arctic_ok([post]))
        results = fetch_arctic_shift_subreddit_posts(
            "Spacemarine", limit=10, game_name="", is_general_sub=False
        )

    assert len(results) == 1
    assert len(results[0]["body"]) == 2000


# ── Test 13: url field is built from permalink ────────────────────────────────

def test_url_built_from_permalink():
    post = _make_post(
        post_id="u1",
        permalink="/r/Spacemarine/comments/u1/great_mission/",
    )

    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, json=_arctic_ok([post]))
        results = fetch_arctic_shift_subreddit_posts(
            "Spacemarine", limit=10, game_name="", is_general_sub=False
        )

    assert results[0]["url"] == "https://www.reddit.com/r/Spacemarine/comments/u1/great_mission/"


# ── Test 14: post_date is a Python datetime (regression test) ───────────────

def test_post_date_is_datetime_not_string():
    """created_utc must be parsed to a Python datetime so SQLAlchemy's
    DateTime column can store it.  Regression test for the 2026-05-30 silent
    failure where every Reddit insert was rejected with StatementError because
    post_date was an ISO 8601 string.  See CLAUDE.md §19.
    """
    post = _make_post(post_id="d1", created_utc=1_700_000_000.0)

    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, json=_arctic_ok([post]))
        results = fetch_arctic_shift_subreddit_posts(
            "Spacemarine", limit=10, game_name="", is_general_sub=False
        )

    assert len(results) == 1
    post_date = results[0]["post_date"]
    assert isinstance(post_date, datetime), (
        f"post_date must be a datetime, got {type(post_date).__name__}: {post_date!r}"
    )
    # Should be tz-aware UTC and round-trip to the expected unix timestamp
    assert post_date.tzinfo is not None
    assert abs(post_date.timestamp() - 1_700_000_000.0) < 1


def test_post_date_none_when_created_utc_missing():
    """Posts without created_utc should yield post_date=None, not crash."""
    post = _make_post(post_id="d2", created_utc=1_700_000_000.0)
    post.pop("created_utc", None)

    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, json=_arctic_ok([post]))
        results = fetch_arctic_shift_subreddit_posts(
            "Spacemarine", limit=10, game_name="", is_general_sub=False
        )

    assert len(results) == 1
    assert results[0]["post_date"] is None


def test_post_date_none_when_created_utc_malformed():
    """Posts with garbage created_utc should yield post_date=None, not crash."""
    post = _make_post(post_id="d3", created_utc=1_700_000_000.0)
    post["created_utc"] = "not-a-number"

    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, json=_arctic_ok([post]))
        results = fetch_arctic_shift_subreddit_posts(
            "Spacemarine", limit=10, game_name="", is_general_sub=False
        )

    assert len(results) == 1
    assert results[0]["post_date"] is None


# ── Test 15: ARCTIC_SHIFT_GENERAL_SUBS contains expected values ───────────────

def test_general_subs_constant_contains_expected_values():
    for expected_sub in ("gaming", "pcgaming", "ps5", "xbox"):
        assert expected_sub in ARCTIC_SHIFT_GENERAL_SUBS, (
            f"Expected '{expected_sub}' to be in ARCTIC_SHIFT_GENERAL_SUBS"
        )


# ── Test 16: Null/zero score → upvotes is 0, not negative ────────────────────

def test_null_score_upvotes_is_zero():
    post = _make_post(post_id="z1", score=-5)  # downvoted posts clamp to 0

    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, json=_arctic_ok([post]))
        results = fetch_arctic_shift_subreddit_posts(
            "Spacemarine", limit=10, game_name="", is_general_sub=False
        )

    assert results[0]["upvotes"] == 0


# ── Test 17: General-sub call with non-None `game` kwarg ─────────────────────
#
# Regression for the 2026-08-18 bug where arctic_shift_service.py had its
# own local `_game_search_query(game_name: str)` copy that did NOT accept
# the `game=` kwarg, but the general-sub code path at line 237 called
# it as `_game_search_query(game_name, game=game)`. Every general-sub
# fetch raised TypeError silently (caught by the outer try/except and
# logged as "unexpected error"), returning 0 posts. The daily cron's
# Phase A wallclock kept growing from the failing subs, and 4 tail-of-list
# games were skipped this morning.
#
# Fix: arctic_shift_service now imports `_game_search_query` directly from
# reddit_service so the two can't drift. This test locks in that the
# general-sub path works when a real (non-None) game object is passed.

def test_general_sub_accepts_non_none_game_kwarg():
    """
    A general-sub fetch with `game=<real Game>` must succeed and issue
    the expected two search requests. Prior to 2026-08-18 this raised
    TypeError inside arctic_shift_service's local `_game_search_query`
    and every general-sub arctic_shift call returned 0 posts.
    """
    from types import SimpleNamespace

    # A minimal object matching the Game shape the caller (ingestor)
    # passes. `distinctive_keywords` is what the (currently disabled)
    # rideshare v3 branch would consult; we mirror the prod shape so the
    # test would still hold if that branch is ever reactivated.
    fake_game = SimpleNamespace(
        id=147,
        name="World War Z",
        distinctive_keywords=["World War Z game", "WWZ Aftermath"],
    )

    on_topic = _make_post(
        post_id="wwz1",
        title="World War Z Aftermath is on sale on Steam",
        selftext="Great co-op zombie shooter, worth picking up",
    )

    responses = [
        _arctic_ok([on_topic]),   # title-search response
        _arctic_ok([]),           # selftext-search response (empty ok)
    ]

    with requests_mock_module.Mocker() as m:
        m.get(ARCTIC_SHIFT_BASE, [{"json": r} for r in responses])
        # This exact call shape (game=<Game>) is what services.ingestor
        # uses in production. The bug made it raise TypeError.
        results = fetch_arctic_shift_subreddit_posts(
            "gaming",
            limit=100,
            game_name="World War Z",
            is_general_sub=True,
            game=fake_game,
        )

    assert m.call_count == 2, (
        "General-sub path with a game kwarg must issue exactly two "
        "requests (title + selftext search)"
    )
    # The regression: prior to the fix, this list was ALWAYS empty because
    # the underlying TypeError swallowed the whole fetch.
    assert len(results) == 1, (
        f"General-sub fetch with a non-None game kwarg must return posts, "
        f"got {len(results)}. If this is 0, arctic_shift_service._game_search_query "
        f"probably drifted from reddit_service._game_search_query again."
    )
    assert results[0]["external_id"] == "wwz1"


# ── Test 18: _game_search_query is the SAME OBJECT as reddit_service's ───────
#
# Companion to test 17: pin down that the fix is import-based, not a
# local re-implementation that could drift again.

def test_game_search_query_is_imported_from_reddit_service_not_duplicated():
    """
    2026-08-18 regression guard. Before the fix, arctic_shift_service had
    its own copy of _game_search_query that drifted out of sync with the
    reddit_service one. The chosen fix was to import directly. This test
    ensures we don't accidentally reintroduce a local copy in a future
    refactor — the two must be the same function object.
    """
    from services.arctic_shift_service import _game_search_query as _ass_gsq
    from services.reddit_service import _game_search_query as _rs_gsq

    assert _ass_gsq is _rs_gsq, (
        "arctic_shift_service._game_search_query must be the SAME object as "
        "reddit_service._game_search_query (imported, not duplicated) so the "
        "two can't drift out of sync. If this fails, someone has re-added a "
        "local copy of the helper in arctic_shift_service.py — delete it and "
        "re-add the import."
    )
