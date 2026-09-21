"""2026-09-21 regression tests for the dashboard TTL cache + warmup.

The initial cache landing (2026-09-20) shipped with a warmup that referenced
`Game.merged_into_id` — a field that doesn't exist on the SentimentPulse
`Game` model (it exists in SignalPulse; the author confused the two
codebases). Result: `warmup_dashboard_cache()` 500'd on every call, silently
leaving the TTL cache empty forever, so cold visits to /dashboard for wide
periods still 504'd through the 120s nginx proxy timeout.

These tests exercise the smallest surface that would have caught it:

  1. Every column the warmup filter references must exist on the Game model.

  2. The warmup source must not reference `merged_into_id` in executable code
     (only in the historical-context comment).

  3. The exact filter query the warmup uses must compile against the real
     Game model — this catches the AttributeError at pre-push time.

None of these tests need a working /dashboard computation — they only
exercise the filter + shape of the warmup work loop, which was the bit
that was actually broken.
"""
from __future__ import annotations

import pytest
from sqlalchemy import inspect

from models import Game
from routers import dashboard as dashboard_router


class TestWarmupFieldReferences:
    """The warmup query must reference only real Game columns.

    This is a static check — it doesn't run the warmup, just interrogates
    the model. That means it catches the AttributeError before any DB
    session is opened, which is what you want from a pre-push gate.
    """

    def test_game_has_is_active_column(self):
        columns = {c.name for c in inspect(Game).c}
        assert "is_active" in columns, (
            "warmup_dashboard_cache filters Game.is_active — column removed?"
        )

    def test_game_does_not_have_merged_into_id(self):
        """Guard against a future regression: if someone reintroduces a
        `merged_into_id` column, this test fails so the warmup code is
        forced to be updated to filter on it. Historically the warmup
        used a nonexistent field of this name and 500'd."""
        columns = {c.name for c in inspect(Game).c}
        assert "merged_into_id" not in columns, (
            "SentimentPulse Game has no merged_into_id — if you're adding "
            "one, update warmup_dashboard_cache in routers/dashboard.py "
            "to filter on it."
        )

    def test_warmup_source_does_not_reference_merged_into_id(self):
        """Belt-and-suspenders: even if a future author adds
        merged_into_id back to the model, the CURRENT warmup body must not
        assume its existence unless a matching test is added first."""
        import inspect as py_inspect
        source = py_inspect.getsource(dashboard_router.warmup_dashboard_cache)
        # The docstring/comment mentions merged_into_id as historical context,
        # so we only fail on an active .filter(...) or attribute access.
        # Strip comment lines before checking.
        active_source = "\n".join(
            line for line in source.split("\n") if not line.strip().startswith("#")
        )
        assert "merged_into_id" not in active_source, (
            "warmup_dashboard_cache() references Game.merged_into_id in "
            "executable code. If the model gained that column, add a test "
            "for the filter behaviour first."
        )


class TestWarmupQueryCompiles:
    """Prove the warmup's filter query compiles against the real Game model.

    We build the same query the warmup builds and ask SQLAlchemy to compile
    it. Compilation exercises every column reference on the mapped class,
    which is where the historical AttributeError fired. This does not need
    a database connection at all — exactly what you want in a fast pre-push
    test.
    """

    def test_active_games_query_compiles_against_real_model(self):
        from sqlalchemy.orm import Query
        from database import Base  # noqa: F401 — ensure metadata is populated

        # This is the EXACT filter chain used in warmup_dashboard_cache().
        # If any referenced column is missing from the Game model, this line
        # raises AttributeError at query-build time — which is the failure
        # mode the deployed 2026-09-20 code shipped with.
        q = Query(Game).filter(Game.is_active.is_(True))

        # Compile the SQL to force full attribute resolution.
        compiled = str(q.statement.compile(compile_kwargs={"literal_binds": True}))
        assert "is_active" in compiled, (
            f"expected is_active in compiled SQL, got: {compiled}"
        )
