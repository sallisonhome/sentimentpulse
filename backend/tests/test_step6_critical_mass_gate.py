"""Regression guard for the 2026-08-05 top-topics-blank bug.

Bug: Step 6 (topic extraction during daily ingest) fed only TODAY's posts
into the topic clusterer, then applied a critical-mass gate that required
each cluster to appear on ≥2 distinct days. Since the input was always
1 day of posts, `distinct_day_count` was ≤ 1 for every cluster, and the
gate rejected 100% of them. Result: every dashboard showed empty top-
topics lists ("Top Positive Topics: —", "Top Negative Topics: —", …)
even though `SentimentRecord` rows existed with real, classified text.

Fix: `_CM_MIN_DAYS` is 1, not 2, so single-day clusters CAN pass the
gate at extraction time. The "topic must persist over time to matter"
semantic is still enforced at the ranking layer (dashboard's
`_weighted_daily_top` and Summary page both aggregate `DailySummary`
rows across the selected period and weight by rank-and-day count).

These tests fail loudly if a future change re-raises `_CM_MIN_DAYS`
above 1 without also widening Step 6's input window past today.
"""
from __future__ import annotations

import pytest


def _get_threshold_values():
    """Import at test-time so a syntax bump doesn't hide the constants."""
    from services.ingestor import _CM_MIN_POSTS, _CM_MIN_AUTHORS, _CM_MIN_DAYS
    return _CM_MIN_POSTS, _CM_MIN_AUTHORS, _CM_MIN_DAYS


class TestCriticalMassThresholds:
    def test_min_days_is_1_not_2(self):
        """The core bug: _CM_MIN_DAYS was 2 while Step 6 only feeds 1 day."""
        _, _, min_days = _get_threshold_values()
        assert min_days == 1, (
            "Step 6 clusters posts from a single day (today), so a >=2-day "
            "threshold is mathematically unsatisfiable and rejects every "
            "cluster. Enforce multi-day persistence at the ranking layer, "
            "not the extraction gate."
        )

    def test_min_posts_and_authors_still_gate_noise(self):
        """We still want noise rejection; only the day gate was wrong."""
        min_posts, min_authors, _ = _get_threshold_values()
        assert min_posts >= 3, "post-count gate should reject <3 mentions"
        assert min_authors >= 3, "author-count gate should reject echo-chamber clusters"


class TestGateSatisfiabilityAgainstStep6Window:
    """Step 6's SQL WHERE clause is `effective_date IN [today, tomorrow)`.
    Any cluster produced from that window has at most 1 distinct day.

    If someone widens the window (multi-day extraction) they can raise
    _CM_MIN_DAYS in the same commit — this test then forces them to keep
    the two consistent.
    """

    def test_gate_can_be_satisfied_by_single_day_input(self):
        """Simulate a cluster that would come out of a single-day pass.

        A well-formed cluster from Step 6's `extract_topics_with_metadata`
        looks like:
          {"label": "graphics",
           "post_count": 5,
           "author_ids": {"a", "b", "c"},
           "day_set": {"2026-08-05"}}
        """
        min_posts, min_authors, min_days = _get_threshold_values()
        cluster = {
            "label": "graphics",
            "post_count": 5,
            "author_ids": {"a", "b", "c"},
            "day_set": {"2026-08-05"},  # single-day, matches Step 6 reality
        }
        pc = cluster["post_count"]
        ac = len(cluster["author_ids"])
        dc = len(cluster["day_set"])
        passes = pc >= min_posts and ac >= min_authors and dc >= min_days
        assert passes, (
            f"Gate must be satisfiable by realistic Step 6 output. "
            f"Got: pc={pc} (min {min_posts}), "
            f"ac={ac} (min {min_authors}), "
            f"dc={dc} (min {min_days})."
        )

    def test_gate_still_rejects_thin_clusters(self):
        """Sanity: a 2-post cluster from 2 authors should still fail."""
        min_posts, min_authors, min_days = _get_threshold_values()
        # 2 posts, 2 authors, 1 day
        pc, ac, dc = 2, 2, 1
        assert not (pc >= min_posts and ac >= min_authors and dc >= min_days), (
            "Small clusters must still be rejected by the noise gate."
        )
