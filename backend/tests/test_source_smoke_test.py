"""Tests for the weekly source smoke test (Gap 1 hardening).

The smoke test pokes each source's REAL fetch function once a week and
flags 'degraded' if any source returns 0 results — catching upstream
regressions like the 2026-06-06 Bluesky atproto-proxy bug BEFORE they
silently zero out a daily ingestion run.
"""
from unittest.mock import patch

import pytest


def test_all_sources_ok():
    """All probes return ≥1 result → overall_status='ok'."""
    from services import source_smoke_test as sst

    with patch.object(sst, "_probe_reddit", return_value=5), \
         patch.object(sst, "_probe_bluesky", return_value=3), \
         patch.object(sst, "_probe_steam_reviews", return_value=10), \
         patch.object(sst, "_probe_steam_forums", return_value=2):
        result = sst.run_smoke_test()

    assert result["overall_status"] == "ok"
    for key in ("reddit", "bluesky", "steam_review", "steam_forum"):
        assert result["results"][key]["status"] == "ok"
        assert result["results"][key]["count"] > 0


def test_single_source_zero_marks_degraded():
    """Reddit returns 0 → overall_status='degraded' and only reddit flagged."""
    from services import source_smoke_test as sst

    with patch.object(sst, "_probe_reddit", return_value=0), \
         patch.object(sst, "_probe_bluesky", return_value=3), \
         patch.object(sst, "_probe_steam_reviews", return_value=10), \
         patch.object(sst, "_probe_steam_forums", return_value=2):
        result = sst.run_smoke_test()

    assert result["overall_status"] == "degraded"
    assert result["results"]["reddit"]["status"] == "degraded"
    assert result["results"]["bluesky"]["status"] == "ok"
    assert result["results"]["steam_review"]["status"] == "ok"
    assert result["results"]["steam_forum"]["status"] == "ok"


def test_probe_exception_flagged_degraded_but_run_continues():
    """A probe that raises is captured per-source; other probes still execute."""
    from services import source_smoke_test as sst

    def boom():
        raise RuntimeError("upstream 500")

    with patch.object(sst, "_probe_bluesky", side_effect=boom), \
         patch.object(sst, "_probe_reddit", return_value=5), \
         patch.object(sst, "_probe_steam_reviews", return_value=10), \
         patch.object(sst, "_probe_steam_forums", return_value=2):
        result = sst.run_smoke_test()

    assert result["overall_status"] == "degraded"
    assert result["results"]["bluesky"]["status"] == "degraded"
    assert "upstream 500" in (result["results"]["bluesky"]["error"] or "")
    # Other sources still completed
    assert result["results"]["reddit"]["status"] == "ok"
    assert result["results"]["steam_review"]["count"] == 10


def test_get_smoke_status_returns_last_run():
    """get_smoke_status returns the snapshot from the most recent run_smoke_test."""
    from services import source_smoke_test as sst

    with patch.object(sst, "_probe_reddit", return_value=1), \
         patch.object(sst, "_probe_bluesky", return_value=1), \
         patch.object(sst, "_probe_steam_reviews", return_value=1), \
         patch.object(sst, "_probe_steam_forums", return_value=1):
        sst.run_smoke_test()

    snap = sst.get_smoke_status()
    assert snap["overall_status"] == "ok"
    assert snap["last_run_at"] is not None
    assert set(snap["results"].keys()) == {
        "reddit", "bluesky", "steam_review", "steam_forum"
    }


def test_all_sources_zero_marks_degraded():
    """All probes return 0 → overall_status='degraded' and every source flagged.

    This is the worst-case regression — every upstream API is unreachable
    or has changed shape.  The smoke test must report ALL of them, not
    short-circuit on the first failure.
    """
    from services import source_smoke_test as sst

    with patch.object(sst, "_probe_reddit", return_value=0), \
         patch.object(sst, "_probe_bluesky", return_value=0), \
         patch.object(sst, "_probe_steam_reviews", return_value=0), \
         patch.object(sst, "_probe_steam_forums", return_value=0):
        result = sst.run_smoke_test()

    assert result["overall_status"] == "degraded"
    for key in ("reddit", "bluesky", "steam_review", "steam_forum"):
        assert result["results"][key]["status"] == "degraded"
