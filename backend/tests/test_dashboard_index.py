"""Tests for migration 0020 — composite index on raw_posts(game_id, post_date).

Guard: the dashboard aggregation queries were 504-ing on 2026-09-20 because
the planner led on ix_raw_posts_is_off_topic_drift (boolean, ~50%
selectivity), scanning ~500k of 1M rows before joining sentiment_records.
Migration 0020 adds a composite index that lets the planner lead on
game_id (~35k rows for a heavy title) and seek by post_date within it.

These tests build the RawPost table in an in-memory SQLite, create the
composite index alongside the existing single-column ones, insert enough
rows to make the planner care, then verify EXPLAIN QUERY PLAN uses the
new index for the exact predicate the dashboard endpoint issues.
"""
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from database import Base
from models import Game, RawPost


class TestDashboardCompositeIndex:
    """Guard that the composite index exists and is picked up by the planner."""

    def _make_engine_with_data(self):
        """Fresh in-memory SQLite with 500 raw_posts across 5 games so the
        planner has enough data to reason about selectivity. We bypass the
        ORM and use raw SQL inserts — the test cares about index selection,
        not FK integrity, and the models have several NOT NULL columns on
        unrelated tables that would be tedious to satisfy here.
        """
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)

        from datetime import datetime, timedelta
        base = datetime(2026, 6, 1)

        with engine.begin() as conn:
            # Seed 500 raw_posts — 100 per game — over ~90 days.
            for gid in range(1, 6):
                for i in range(100):
                    conn.execute(text(
                        "INSERT INTO raw_posts "
                        "(game_id, source, external_id, post_date, is_off_topic_drift, upvotes) "
                        "VALUES (:gid, 'steam_forums', :ext, :pd, :drift, 0)"
                    ), {
                        "gid": gid,
                        "ext": f"g{gid}_p{i}",
                        "pd": (base + timedelta(days=i)).isoformat(),
                        "drift": 1 if (i % 2 == 0) else 0,
                    })

            # ANALYZE populates sqlite_stat1 so the planner uses real
            # selectivity rather than fallback heuristics.
            conn.execute(text("ANALYZE"))

        return engine

    def test_composite_index_exists_after_create_all(self):
        """After Base.metadata.create_all(), the composite index must exist."""
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)

        with engine.connect() as conn:
            rows = conn.execute(text(
                "SELECT name FROM sqlite_master "
                "WHERE type='index' AND tbl_name='raw_posts' "
                "AND name='ix_raw_posts_game_id_post_date'"
            )).fetchall()

        assert len(rows) == 1, (
            "Composite index ix_raw_posts_game_id_post_date is missing. "
            "It must be declared in models.py::RawPost.__table_args__ AND "
            "created by migration 0020 so both fresh-DB and prod paths get it."
        )

    def test_planner_uses_composite_index_for_dashboard_predicate(self):
        """The exact predicate the /dashboard KPI query issues must use the
        composite index, not the low-selectivity is_off_topic_drift index
        that caused the 2026-09-20 outage.
        """
        engine = self._make_engine_with_data()

        with engine.connect() as conn:
            # This is the EXACT filter chain from _compute_dashboard's KPI query.
            plan = conn.execute(text(
                "EXPLAIN QUERY PLAN "
                "SELECT sr.sentiment, COUNT(sr.id) "
                "FROM sentiment_records sr "
                "JOIN raw_posts rp ON sr.raw_post_id = rp.id "
                "WHERE rp.game_id = 1 "
                "  AND rp.post_date IS NOT NULL "
                "  AND rp.is_off_topic_drift = 0 "
                "  AND DATE(rp.post_date) >= '2026-08-01' "
                "GROUP BY sr.sentiment"
            )).fetchall()

        plan_text = " | ".join(row[3] for row in plan)

        assert "ix_raw_posts_game_id_post_date" in plan_text, (
            f"Planner did NOT pick the composite index. Full plan:\n{plan_text}\n"
            "This means the query will 504 in production again. Either the "
            "index is missing or its column order is wrong (must be "
            "(game_id, post_date), not (post_date, game_id))."
        )
        assert "is_off_topic_drift" not in plan_text or "SEARCH rp USING INDEX ix_raw_posts_is_off_topic_drift" not in plan_text, (
            f"Planner regressed to the low-selectivity boolean index. Plan:\n{plan_text}"
        )
