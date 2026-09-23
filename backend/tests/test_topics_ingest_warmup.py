"""2026-09-22 — Top Topics must populate after ingest without a dashboard visit.

v0031 split Top Topics onto GET /dashboard/topics with an in-memory LLM cache.
warmup_dashboard_cache() only fills KPI/volume and returns empty topic arrays.
The synthesizer TTL was 15 minutes, so even a successful visit expired before
morning. These tests pin the two contracts that keep the widget filled:

  1. TTL outlives overnight ingest → morning dashboard view.
  2. The ingest post-hook starts topics warmup (today + weekly).
  3. Topics warmup exists and does not fan out to lifetime/quarterly LLM work.
"""
from __future__ import annotations

import ast
import inspect
from pathlib import Path

from routers import dashboard as dashboard_router
from services import dashboard_feedback_synthesizer as synth
from services import ingestor


INGESTOR_PY = Path(__file__).parent.parent / "services" / "ingestor.py"


class TestTopicsCacheTtl:
    def test_ttl_outlives_ingest_to_morning_view(self):
        assert synth._CACHE_TTL_SEC >= 12 * 60 * 60, (
            f"Top Topics TTL is {synth._CACHE_TTL_SEC}s. A 15-minute TTL "
            "expires between 02:00 ingest and a morning dashboard visit, so "
            "the widget looks empty even after a successful warmup. Keep TTL "
            "at least 12 hours."
        )


class TestIngestStartsTopicsWarmup:
    def test_ingestor_calls_start_topics_warmup_background(self):
        source = INGESTOR_PY.read_text()
        assert "start_topics_warmup_background" in source, (
            "Ingest post-hook does not start Top Topics warmup. KPI warmup "
            "does not fill the topics cache (v0031). The widget will stay "
            "empty until someone opens the dashboard and waits for LLM work."
        )

    def test_start_topics_warmup_is_fire_and_forget(self):
        source = inspect.getsource(dashboard_router.start_topics_warmup_background)
        assert "threading.Thread" in source
        assert "daemon=True" in source or "daemon = True" in source


class TestTopicsWarmupScope:
    def test_warmup_covers_today_and_weekly(self):
        source = inspect.getsource(dashboard_router.warmup_topics_cache)
        assert "PeriodEnum.today" in source
        assert "PeriodEnum.weekly" in source

    def test_warmup_does_not_block_on_lifetime(self):
        source = inspect.getsource(dashboard_router.warmup_topics_cache)
        assert "PeriodEnum.lifetime" not in source
        assert "PeriodEnum.quarterly" not in source

    def test_warmup_topics_cache_is_a_function(self):
        assert callable(dashboard_router.warmup_topics_cache)
        assert callable(dashboard_router.start_topics_warmup_background)


class TestStartupAndManualTopicsWarmup:
    def test_startup_schedules_topics_warmup(self):
        source = (Path(__file__).parent.parent / "main.py").read_text()
        assert "start_topics_warmup_background" in source, (
            "App startup does not warm Top Topics. Every deploy/restart "
            "wipes the in-memory cache and the card stays empty until the "
            "next ingest."
        )

    def test_manual_topics_warmup_endpoint_registered(self):
        paths = {getattr(r, "path", "") for r in dashboard_router.router.routes}
        assert any(p.endswith("/dashboard/topics-warmup") for p in paths)
