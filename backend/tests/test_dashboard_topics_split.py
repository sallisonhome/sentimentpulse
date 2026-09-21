"""Guard: v0031 (2026-09-21) split the LLM-driven Top Topics work off the
main /dashboard endpoint into its own /dashboard/topics endpoint.

The main dashboard used to synchronously call generate_feedback_summary()
three times per request, each of which fires multiple LLM synthesis calls
(one per topic cluster). On cold cache with a heavy title (Hellraiser,
~9k posts), that took 60-120+s per period and 504'd the whole dashboard
through nginx's 120s proxy_read_timeout.

These tests prove:
  1. _compute_dashboard NEVER imports or calls generate_feedback_summary.
  2. The /dashboard/topics endpoint exists on the router.

If someone adds the LLM call back into _compute_dashboard in a future
refactor, test 1 fails at pre-push and we catch it before shipping.
"""
import re
from pathlib import Path

import pytest

DASHBOARD_PY = Path(__file__).parent.parent / "routers" / "dashboard.py"


class TestTopicsSplit:
    def test_compute_dashboard_does_not_call_generate_feedback_summary(self):
        """The _compute_dashboard function must not invoke the LLM
        synthesizer directly. Any call site belongs in the separate
        /dashboard/topics endpoint (get_dashboard_topics).

        We parse the source with `ast` so a mention in a docstring or
        comment doesn't trip the guard — only actual code references
        count as a real call site.
        """
        import ast

        tree = ast.parse(DASHBOARD_PY.read_text())
        target = None
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "_compute_dashboard":
                target = node
                break
        assert target is not None, "_compute_dashboard not found in dashboard.py"

        # Any Name / Attribute / alias reference to generate_feedback_summary
        # inside _compute_dashboard's body counts as a call site. Docstrings
        # (ast.Constant strings) are ignored.
        offenders = []
        for node in ast.walk(target):
            if isinstance(node, ast.Name) and node.id == "generate_feedback_summary":
                offenders.append(node.lineno)
            elif isinstance(node, ast.Attribute) and node.attr == "generate_feedback_summary":
                offenders.append(node.lineno)
            elif isinstance(node, ast.alias) and node.name == "generate_feedback_summary":
                offenders.append(node.lineno)

        assert not offenders, (
            f"_compute_dashboard references generate_feedback_summary at lines {offenders} — "
            "that reintroduces the LLM latency that caused the 2026-09-20/21 "
            "dashboard 504 incident. Move the call into get_dashboard_topics "
            "instead (see v0031 comment in the router)."
        )

    def test_dashboard_topics_endpoint_registered(self):
        """The new endpoint must exist on the router."""
        import sys
        # Ensure backend/ is on the path so routers.dashboard resolves.
        backend = Path(__file__).parent.parent
        if str(backend) not in sys.path:
            sys.path.insert(0, str(backend))

        from routers.dashboard import router

        paths = {r.path for r in router.routes}
        assert "/games/{game_id}/dashboard/topics" in paths, (
            "GET /games/{game_id}/dashboard/topics is not registered. "
            f"Registered routes: {sorted(paths)}"
        )

    def test_dashboard_topics_endpoint_calls_generate_feedback_summary(self):
        """The topics endpoint MUST call generate_feedback_summary — it's the
        whole point of splitting it out. If it stops calling, topics data
        will be empty for every user.
        """
        import ast

        tree = ast.parse(DASHBOARD_PY.read_text())
        target = None
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "get_dashboard_topics":
                target = node
                break
        assert target is not None, "get_dashboard_topics not found in dashboard.py"

        found = False
        for node in ast.walk(target):
            if isinstance(node, ast.Name) and node.id == "generate_feedback_summary":
                found = True
                break
            if isinstance(node, ast.alias) and node.name == "generate_feedback_summary":
                found = True
                break

        assert found, (
            "get_dashboard_topics no longer references generate_feedback_summary — "
            "the Top Topics widget will be empty for every user. Restore the "
            "call inside this endpoint."
        )
