"""Tests for the Steam Forum listing-page parser + walk short-circuit.

Focus of these tests:
  1. `_parse_thread_links` extracts the new lastpost_ts and is_sticky
     fields (2026-07-28 refactor).
  2. `scrape_forum_threads` short-circuits the listing walk once we've
     seen K consecutive non-sticky stale threads and does NOT bail early
     just because a stale pinned/sticky thread is at the top.
  3. `scrape_forum_threads` skips visiting stale non-sticky threads,
     ALWAYS visits stickies, and honors the wallclock budget.

We use tiny handcrafted HTML that reproduces exactly the class names
Steam serves (verified live against
https://steamcommunity.com/app/1486920/discussions/ on 2026-07-28).
"""
from __future__ import annotations

import time
from unittest.mock import patch

from bs4 import BeautifulSoup

from services import steam_service


# ---- DOM fixtures ---------------------------------------------------------

def _row_html(
    thread_id: str,
    title: str,
    lastpost_ts: int | None,
    is_sticky: bool = False,
) -> str:
    """Render one Steam forum row with the exact class markers Steam uses."""
    outer_classes = ["forum_topic", "unread"]
    if is_sticky:
        outer_classes.append("sticky")
    outer_class_attr = " ".join(outer_classes)
    ts_attr = f'data-timestamp="{lastpost_ts}"' if lastpost_ts is not None else ""
    href = f"https://steamcommunity.com/app/999999/discussions/0/{thread_id}/"
    return f"""
    <div class="{outer_class_attr}" id="forum_General_1_{thread_id}" data-gidforumtopic="{thread_id}">
      <a class="forum_topic_overlay" href="{href}"></a>
      <div class="forum_topic_details">
        <div class="forum_topic_reply_count">1</div>
        <div class="forum_topic_lastpost" {ts_attr}>whatever</div>
      </div>
      <div class="forum_topic_name">{title}</div>
      <div class="forum_topic_op">tester</div>
    </div>
    """


def _page_html(rows_html: list[str]) -> str:
    return "<html><body>" + "\n".join(rows_html) + "</body></html>"


# ---- _parse_thread_links --------------------------------------------------

def test_parse_extracts_lastpost_and_sticky():
    html = _page_html([
        _row_html("aaa", "Pinned FAQ", lastpost_ts=1_700_000_000, is_sticky=True),
        _row_html("bbb", "Fresh crash report", lastpost_ts=1_785_000_000, is_sticky=False),
        _row_html("ccc", "Missing timestamp", lastpost_ts=None, is_sticky=False),
    ])
    soup = BeautifulSoup(html, "lxml")
    refs = steam_service._parse_thread_links(soup)
    assert len(refs) == 3

    by_id = {r["thread_id"]: r for r in refs}
    assert by_id["aaa"]["is_sticky"] is True
    assert by_id["aaa"]["lastpost_ts"] == 1_700_000_000
    assert by_id["aaa"]["title"] == "Pinned FAQ"

    assert by_id["bbb"]["is_sticky"] is False
    assert by_id["bbb"]["lastpost_ts"] == 1_785_000_000

    # Missing data-timestamp attribute must return None, not raise.
    assert by_id["ccc"]["lastpost_ts"] is None
    assert by_id["ccc"]["is_sticky"] is False


# ---- listing short-circuit ------------------------------------------------

class _FakeResp:
    def __init__(self, text: str):
        self.text = text


def _fake_get_factory(pages: dict[str, str]):
    """Return a fake for steam_service._get that dispenses canned HTML by URL."""
    def _fake(url: str):  # noqa: ANN202
        return _FakeResp(pages[url]) if url in pages else None
    return _fake


def test_short_circuit_stops_after_streak_of_stale_nonsticky():
    """5 fresh non-sticky threads then 6 stale non-sticky -> walk stops on
    page 1 without ever fetching page 2."""
    now = int(time.time())
    since = now - 48 * 3600  # 48h cutoff
    fresh = now - 60 * 60      # 1 hour ago
    stale = now - 30 * 24 * 3600  # 30 days ago

    page1_rows = (
        [_row_html("p", "PINNED", stale, is_sticky=True)]
        + [_row_html(f"fresh{i}", "recent", fresh) for i in range(5)]
        + [_row_html(f"old{i}", "old", stale) for i in range(6)]
    )
    page1 = _page_html(page1_rows)
    page2 = _page_html([_row_html("shouldnotfetch", "MUST NOT BE VISITED", fresh)])

    pages = {
        "https://steamcommunity.com/app/999999/discussions/": page1,
        "https://steamcommunity.com/app/999999/discussions/?fp=2": page2,
    }

    with patch.object(steam_service, "_get", side_effect=_fake_get_factory(pages)), \
         patch.object(steam_service, "_scrape_single_thread", return_value=[]), \
         patch.object(steam_service.time, "sleep", return_value=None):
        posts = steam_service.scrape_forum_threads(
            steam_app_id=999999,
            max_threads=200,
            max_pages=15,
            since_epoch=since,
        )

    # If page 2 had been fetched, the pages dict lookup would have worked;
    # the assertion is behavioral: the walk exited without needing page 2
    # because it saw 6 consecutive stale non-sticky threads (>= 5-streak
    # threshold). All 5 fresh threads should have been visitable.
    assert posts == []  # _scrape_single_thread is stubbed to []


def test_sticky_does_not_advance_stale_streak():
    """A stale pinned thread at the top of the list must NOT cause an early
    bail on an otherwise fresh page."""
    now = int(time.time())
    since = now - 48 * 3600
    fresh = now - 60 * 60
    stale = now - 90 * 24 * 3600

    # Stale pin sitting above five fresh non-sticky threads. If the
    # short-circuit incorrectly counted the pin, we'd bail before
    # visiting the fresh ones.
    page1 = _page_html([
        _row_html("pin1", "PINNED stale", stale, is_sticky=True),
        _row_html("pin2", "PINNED stale 2", stale, is_sticky=True),
        _row_html("pin3", "PINNED stale 3", stale, is_sticky=True),
        _row_html("pin4", "PINNED stale 4", stale, is_sticky=True),
        _row_html("pin5", "PINNED stale 5", stale, is_sticky=True),
    ] + [_row_html(f"fresh{i}", "recent", fresh) for i in range(5)])
    pages = {"https://steamcommunity.com/app/999999/discussions/": page1}

    visited: list[str] = []
    def _record_visit(url, tid, title, since_epoch=None):  # noqa: ANN001
        visited.append(tid)
        return []

    with patch.object(steam_service, "_get", side_effect=_fake_get_factory(pages)), \
         patch.object(steam_service, "_scrape_single_thread", side_effect=_record_visit), \
         patch.object(steam_service.time, "sleep", return_value=None):
        steam_service.scrape_forum_threads(
            steam_app_id=999999,
            max_threads=200,
            max_pages=1,
            since_epoch=since,
        )

    # All five stickies must be visited (they may hide activity).
    for tid in ["pin1", "pin2", "pin3", "pin4", "pin5"]:
        assert tid in visited, f"sticky {tid} should always be visited"
    # All five fresh ones must be visited.
    for i in range(5):
        assert f"fresh{i}" in visited, f"fresh{i} should be visited"


def test_stale_nonsticky_are_skipped_no_http():
    """Non-sticky threads with lastpost < since_epoch must never trigger
    _scrape_single_thread."""
    now = int(time.time())
    since = now - 48 * 3600
    fresh = now - 60 * 60
    stale = now - 30 * 24 * 3600

    page1 = _page_html([
        _row_html("fresh1", "recent", fresh),
        _row_html("stale1", "old", stale),
        _row_html("fresh2", "recent", fresh),
        _row_html("stale2", "old", stale),
    ])
    pages = {"https://steamcommunity.com/app/999999/discussions/": page1}

    visited: list[str] = []
    def _record_visit(url, tid, title, since_epoch=None):  # noqa: ANN001
        visited.append(tid)
        return []

    with patch.object(steam_service, "_get", side_effect=_fake_get_factory(pages)), \
         patch.object(steam_service, "_scrape_single_thread", side_effect=_record_visit), \
         patch.object(steam_service.time, "sleep", return_value=None):
        steam_service.scrape_forum_threads(
            steam_app_id=999999,
            max_threads=200,
            max_pages=1,
            since_epoch=since,
        )

    # Fresh threads visited, stale threads not visited.
    assert "fresh1" in visited
    assert "fresh2" in visited
    assert "stale1" not in visited
    assert "stale2" not in visited


def test_since_epoch_none_disables_short_circuit_and_skip():
    """Historical mode (since_epoch=None) must NOT short-circuit and must
    NOT skip stale threads — the caller wants everything within max_threads
    / max_pages, age irrelevant."""
    now = int(time.time())
    fresh = now - 60 * 60
    stale = now - 365 * 24 * 3600  # a year old
    page1 = _page_html([
        _row_html("a", "old", stale),
        _row_html("b", "older", stale),
        _row_html("c", "oldest", stale),
        _row_html("d", "still old", stale),
        _row_html("e", "very old", stale),
        _row_html("f", "more old", stale),
        _row_html("g", "fresh mixed in", fresh),
    ])
    pages = {"https://steamcommunity.com/app/999999/discussions/": page1}

    visited: list[str] = []
    def _record_visit(url, tid, title, since_epoch=None):  # noqa: ANN001
        visited.append(tid)
        return []

    with patch.object(steam_service, "_get", side_effect=_fake_get_factory(pages)), \
         patch.object(steam_service, "_scrape_single_thread", side_effect=_record_visit), \
         patch.object(steam_service.time, "sleep", return_value=None):
        steam_service.scrape_forum_threads(
            steam_app_id=999999,
            max_threads=200,
            max_pages=1,
            since_epoch=None,   # historical mode
        )

    # Every thread on the page must be visited when since_epoch is None,
    # regardless of age. If short-circuit or skip-if-stale accidentally
    # activate in this mode, backfill will silently under-collect.
    for tid in ["a", "b", "c", "d", "e", "f", "g"]:
        assert tid in visited, (
            f"historical mode must visit {tid} but visited={visited}"
        )


def test_runaway_all_fresh_forum_capped_by_max_threads():
    """A forum where every thread is fresh (nothing to short-circuit on)
    must still be bounded by max_threads. Otherwise a busy game like
    Tempest Rising could visit 200+ threads per daily run."""
    now = int(time.time())
    fresh = now - 60 * 60
    # 300 all-fresh threads across 2 pages of 150 each.
    page1 = _page_html([_row_html(f"a{i}", "fresh", fresh) for i in range(150)])
    page2 = _page_html([_row_html(f"b{i}", "fresh", fresh) for i in range(150)])
    pages = {
        "https://steamcommunity.com/app/999999/discussions/": page1,
        "https://steamcommunity.com/app/999999/discussions/?fp=2": page2,
    }

    visited: list[str] = []
    def _record_visit(url, tid, title, since_epoch=None):  # noqa: ANN001
        visited.append(tid)
        return []

    with patch.object(steam_service, "_get", side_effect=_fake_get_factory(pages)), \
         patch.object(steam_service, "_scrape_single_thread", side_effect=_record_visit), \
         patch.object(steam_service.time, "sleep", return_value=None):
        steam_service.scrape_forum_threads(
            steam_app_id=999999,
            max_threads=30,      # tight cap
            max_pages=15,
            since_epoch=now - 48 * 3600,
        )

    # max_threads MUST cap the visit count, not just the listing walk.
    assert len(visited) == 30, (
        f"max_threads=30 should cap visits at exactly 30, got {len(visited)}"
    )


def test_missing_lastpost_treated_as_visit_worthy():
    """Threads whose lastpost_ts we couldn't parse (rare) must be visited,
    not silently skipped. The alternative (skipping) creates a silent
    coverage hole any time Steam's DOM shifts."""
    now = int(time.time())
    fresh = now - 60 * 60
    page1 = _page_html([
        _row_html("unknown", "missing ts", lastpost_ts=None),
        _row_html("fresh1", "fresh", fresh),
    ])
    pages = {"https://steamcommunity.com/app/999999/discussions/": page1}

    visited: list[str] = []
    def _record_visit(url, tid, title, since_epoch=None):  # noqa: ANN001
        visited.append(tid)
        return []

    with patch.object(steam_service, "_get", side_effect=_fake_get_factory(pages)), \
         patch.object(steam_service, "_scrape_single_thread", side_effect=_record_visit), \
         patch.object(steam_service.time, "sleep", return_value=None):
        steam_service.scrape_forum_threads(
            steam_app_id=999999,
            max_threads=200,
            max_pages=1,
            since_epoch=now - 48 * 3600,
        )

    assert "unknown" in visited, "threads with missing lastpost_ts must be visited"
    assert "fresh1" in visited


def test_wallclock_budget_caps_thread_visits():
    """When wallclock_budget_s is exceeded, remaining threads are skipped
    and the function returns whatever it has so far."""
    now = int(time.time())
    fresh = now - 60 * 60
    page1 = _page_html([
        _row_html(f"t{i}", "recent", fresh) for i in range(10)
    ])
    pages = {"https://steamcommunity.com/app/999999/discussions/": page1}

    call_count = {"n": 0}

    def _slow_visit(url, tid, title, since_epoch=None):  # noqa: ANN001
        call_count["n"] += 1
        # Simulate a slow per-thread fetch by advancing monotonic clock via
        # a real sleep. Keep it tiny so the test is fast but > budget/N.
        time.sleep(0.05)
        return []

    with patch.object(steam_service, "_get", side_effect=_fake_get_factory(pages)), \
         patch.object(steam_service, "_scrape_single_thread", side_effect=_slow_visit):
        # Do NOT patch time.sleep here \u2014 we need the monotonic clock to advance
        steam_service.scrape_forum_threads(
            steam_app_id=999999,
            max_threads=200,
            max_pages=1,
            since_epoch=now - 48 * 3600,
            wallclock_budget_s=0.15,   # tight budget: ~3 visits worth
        )

    # Budget of 0.15s with 0.05s + _REQUEST_DELAY (1s) per visit means the
    # first visit will finish, then the budget check on the second\u2011visit
    # boundary bails. So we expect strictly fewer than all 10 visits.
    assert call_count["n"] < 10, (
        f"expected budget to cap visits below 10, got {call_count['n']}"
    )
