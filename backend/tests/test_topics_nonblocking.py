"""Guard: v0031b (2026-09-21) — /dashboard/topics endpoint is non-blocking.

Before v0031b, the endpoint synchronously called generate_feedback_summary()
which could take 60-120+s on cold cache with heavy titles, leading to
nginx 504s at the 120s proxy_read_timeout.

The v0031b design:
  - Probe the synthesizer's own TTL cache (services/dashboard_feedback_
    synthesizer.py::_CACHE) via _cache_get() for each of the three
    sentiments.
  - If all three are cached: return the real data with status='ready'.
  - If ANY is uncached: kick off a background thread to compute all
    three, and return status='pending' with empty arrays immediately.

These tests exercise the source contract to guard against regressions:
  1. The endpoint imports/uses _cache_get (probing the cache directly,
     not synchronously running the synthesizer).
  2. The endpoint has a `status` field in its response builder for both
     'ready' and 'pending' paths.
  3. The response schema (TopTopicsSummary) has a `status` field with a
     default of 'ready' (for schema backwards compatibility).
"""
import ast
from pathlib import Path

DASHBOARD_PY = Path(__file__).parent.parent / "routers" / "dashboard.py"
SCHEMAS_PY = Path(__file__).parent.parent / "schemas.py"


class TestTopicsNonblocking:
    def test_endpoint_probes_synthesizer_cache_directly(self):
        """get_dashboard_topics must import _cache_get from the synthesizer
        (i.e. probe the cache rather than always calling generate_
        feedback_summary synchronously)."""
        tree = ast.parse(DASHBOARD_PY.read_text())
        target = None
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "get_dashboard_topics":
                target = node
                break
        assert target is not None, "get_dashboard_topics not found"

        found_cache_get = False
        for node in ast.walk(target):
            if isinstance(node, ast.alias) and node.name == "_cache_get":
                found_cache_get = True
                break
            if isinstance(node, ast.Name) and node.id == "_synth_cache_get":
                found_cache_get = True
                break

        assert found_cache_get, (
            "get_dashboard_topics does not import or use _cache_get from "
            "dashboard_feedback_synthesizer. That means it's running the "
            "LLM synthesizer synchronously and will 504 on cold cache. "
            "See v0031b comment in the router."
        )

    def test_endpoint_has_pending_and_ready_status_values(self):
        """The endpoint must build responses with both status='ready' and
        status='pending' — otherwise the non-blocking path is missing."""
        source = DASHBOARD_PY.read_text()
        start = source.index("def get_dashboard_topics(")
        # Slice to next module-level def or decorator.
        rest = source[start:]
        import re
        m = re.search(r"\n(def |@router\.)", rest[len("def get_dashboard_topics("):])
        body = rest if m is None else rest[: len("def get_dashboard_topics(") + m.start()]

        assert 'status="ready"' in body or "status='ready'" in body, (
            "get_dashboard_topics is missing a status='ready' response path."
        )
        assert 'status="pending"' in body or "status='pending'" in body, (
            "get_dashboard_topics is missing a status='pending' response path. "
            "That means the non-blocking / kick-off-background-thread path is "
            "missing and cold visits will still 504. See v0031b."
        )

    def test_endpoint_starts_background_thread(self):
        """The endpoint must spawn a background thread for the cold path
        (via threading.Thread) — otherwise the cache never gets populated
        and every visit stays 'pending' forever.
        """
        source = DASHBOARD_PY.read_text()
        start = source.index("def get_dashboard_topics(")
        import re
        rest = source[start:]
        m = re.search(r"\n(def |@router\.)", rest[len("def get_dashboard_topics("):])
        body = rest if m is None else rest[: len("def get_dashboard_topics(") + m.start()]

        assert "threading.Thread" in body, (
            "get_dashboard_topics doesn't spawn a background thread — "
            "the cold cache path will stay pending forever with no work "
            "happening to populate it. See v0031b."
        )

    def test_toptopicssummary_has_status_field_defaulting_to_ready(self):
        """Schema must add `status: str = 'ready'` so older clients (that
        don't send/care about the field) continue to work."""
        tree = ast.parse(SCHEMAS_PY.read_text())
        target = None
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == "TopTopicsSummary":
                target = node
                break
        assert target is not None, "TopTopicsSummary schema not found"

        found_status = False
        for stmt in target.body:
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                if stmt.target.id == "status":
                    found_status = True
                    # Should have a default value of "ready".
                    assert stmt.value is not None, (
                        "TopTopicsSummary.status has no default; must default "
                        "to 'ready' for schema backwards compatibility."
                    )
                    if isinstance(stmt.value, ast.Constant):
                        assert stmt.value.value == "ready", (
                            f"TopTopicsSummary.status default is "
                            f"{stmt.value.value!r}, expected 'ready'."
                        )
                    break

        assert found_status, (
            "TopTopicsSummary schema is missing the `status: str = 'ready'` "
            "field required by v0031b non-blocking topics endpoint."
        )
