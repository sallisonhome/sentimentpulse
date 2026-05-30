"""Source-service post_date contract tests.

Every source service that feeds posts into ingestor._bulk_save_posts MUST
return post_date as either a Python `datetime` instance or `None`.  String
dates (e.g. ISO 8601 from .isoformat()) cause SQLAlchemy's DateTime column
to raise StatementError(TypeError), which _bulk_save_posts swallows in its
generic-Exception branch — producing the silent-failure pattern that caused
both the 2026-05-29 Bluesky bug and the 2026-05-30 Reddit bug.

These tests freeze the contract in place so future regressions surface
immediately rather than weeks later in production.  See CLAUDE.md §19.
"""
import inspect
from datetime import datetime, timezone


# ── Arctic Shift (Reddit) ────────────────────────────────────────────────────

def test_arctic_shift_convert_post_returns_datetime():
    from services.arctic_shift_service import _convert_post
    raw = {
        "id": "abc123",
        "title": "test",
        "selftext": "body",
        "author": "user",
        "permalink": "/r/test/comments/abc/",
        "created_utc": 1_700_000_000.0,
        "score": 10,
    }
    converted = _convert_post(raw)
    assert converted is not None
    assert isinstance(converted["post_date"], datetime), (
        f"arctic_shift post_date must be datetime, got "
        f"{type(converted['post_date']).__name__}: {converted['post_date']!r}"
    )


def test_arctic_shift_convert_post_handles_missing_created_utc():
    from services.arctic_shift_service import _convert_post
    raw = {"id": "abc123", "title": "test", "selftext": "", "author": "u",
           "permalink": "", "score": 0}
    converted = _convert_post(raw)
    assert converted is not None
    assert converted["post_date"] is None


# ── Bluesky ──────────────────────────────────────────────────────────────────

def test_bluesky_convert_post_returns_datetime():
    from services.bluesky_service import _convert_post
    raw = {
        "uri": "at://did:plc:abc/app.bsky.feed.post/rkey",
        "cid": "cid",
        "author": {"handle": "test.bsky.social"},
        "record": {"text": "hello", "createdAt": "2026-05-30T12:00:00Z"},
        "likeCount": 0,
    }
    converted = _convert_post(raw)
    assert converted is not None
    assert isinstance(converted["post_date"], datetime), (
        f"bluesky post_date must be datetime, got "
        f"{type(converted['post_date']).__name__}: {converted['post_date']!r}"
    )


def test_bluesky_convert_post_handles_missing_created_at():
    from services.bluesky_service import _convert_post
    raw = {
        "uri": "at://did:plc:abc/app.bsky.feed.post/rkey",
        "cid": "cid",
        "author": {"handle": "test.bsky.social"},
        "record": {"text": "hello"},
        "likeCount": 0,
    }
    converted = _convert_post(raw)
    assert converted is not None
    assert converted["post_date"] is None


# ── Steam Reviews ────────────────────────────────────────────────────────────

def test_steam_review_dict_uses_datetime_post_date():
    """Steam review conversion uses datetime.fromtimestamp(...) which already
    returns a datetime.  This test freezes that fact in place."""
    pd = datetime.fromtimestamp(1_700_000_000, tz=timezone.utc)
    assert isinstance(pd, datetime)
    # Sanity: confirm steam_service still uses this exact pattern in the
    # review fetcher.  If someone refactors to .isoformat() we want to know.
    import services.steam_service as steam_mod
    src = inspect.getsource(steam_mod)
    assert "datetime.fromtimestamp(" in src, (
        "steam_service no longer uses datetime.fromtimestamp — review the "
        "review-fetcher path and ensure post_date is still a datetime."
    )


# ── Steam Forums ─────────────────────────────────────────────────────────────

def test_steam_forum_date_parser_returns_datetime():
    from services.steam_service import _parse_steam_date
    samples = [
        "5 Mar @ 4:30PM",
        "5 Mar, 2026 @ 4:30PM",
        "Mar 5, 2026 @ 4:30PM",
        "Mar 5 @ 4:30PM",
        "Mar 5, 2026",
    ]
    matched_at_least_one = False
    for s in samples:
        result = _parse_steam_date(s)
        if result is not None:
            assert isinstance(result, datetime), (
                f"_parse_steam_date({s!r}) returned {type(result).__name__}, "
                f"expected datetime or None"
            )
            matched_at_least_one = True
    assert matched_at_least_one, "None of the supported Steam date formats parsed"


def test_steam_forum_date_parser_returns_none_for_garbage():
    from services.steam_service import _parse_steam_date
    assert _parse_steam_date(None) is None
    assert _parse_steam_date("") is None
    assert _parse_steam_date("not a date") is None
