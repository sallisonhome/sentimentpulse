"""
Tests for the 1-day window topic aggregation path.

§15 conflict-resolution: when window_days==1, the nightly _step6_extract_topics
never stores cached topic labels per post (it requires ≥2 distinct days which a
single-day window can never satisfy). The fix is _aggregate_posts_1day(), which
calls topic_service.extract_topics_with_metadata directly with a relaxed gate:
  - ≥3 distinct posts
  - ≥3 distinct authors
  - NO day-span requirement

These tests verify shape, gate logic, and integration with generate_window_summary.
All topic_service calls are mocked so no real text clustering happens.
"""
from datetime import date, datetime
from unittest.mock import MagicMock, patch

import pytest

from services import period_summary_service as pss


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_cluster(label: str, post_count: int, author_count: int) -> dict:
    """Build a fake cluster dict as returned by topic_service.extract_topics_with_metadata."""
    return {
        "label": label,
        "post_count": post_count,
        "author_ids": {f"user_{i}" for i in range(author_count)},
        "day_set": {"2024-01-15"},
    }


def _insert_post(db, game_id: int, sentiment, author: str, day: date, ext_id: str):
    """Insert a RawPost + SentimentRecord for test setup."""
    from models import RawPost, SentimentRecord, SourceEnum

    post = RawPost(
        game_id=game_id,
        source=SourceEnum.steam_review,
        external_id=ext_id,
        author=author,
        title=f"Fuel changes are horrible for gameplay balance and need to be reverted",
        body=f"The fuel mechanic breaks everything. Authored by {author}.",
        url=f"https://example.com/{ext_id}",
        upvotes=5,
        collected_at=datetime.combine(day, datetime.min.time()),
        post_date=datetime.combine(day, datetime.min.time()),
    )
    db.add(post)
    db.flush()

    sr = SentimentRecord(
        raw_post_id=post.id,
        sentiment=sentiment,
        sentiment_score=0.85,
        topics=[],  # empty — as per §15 1-day conflict
    )
    db.add(sr)
    db.flush()
    return post, sr


# ── Shape tests ───────────────────────────────────────────────────────────────

class TestAggregatePosts1DayShape:
    """_aggregate_posts_1day must always return a 6-tuple of the correct types."""

    def test_returns_six_tuple(self, db, game):
        result = pss._aggregate_posts_1day(db, game.id, date(2024, 1, 15))
        assert isinstance(result, tuple)
        assert len(result) == 6

    def test_types_are_correct(self, db, game):
        pos, neg, neu, top_pos, top_neg, top_neu = pss._aggregate_posts_1day(
            db, game.id, date(2024, 1, 15)
        )
        assert isinstance(pos, int)
        assert isinstance(neg, int)
        assert isinstance(neu, int)
        assert isinstance(top_pos, list)
        assert isinstance(top_neg, list)
        assert isinstance(top_neu, list)

    def test_empty_day_returns_zeros_and_empty_lists(self, db, game):
        """A day with no posts returns all zeros and empty topic lists."""
        pos, neg, neu, top_pos, top_neg, top_neu = pss._aggregate_posts_1day(
            db, game.id, date(2024, 1, 15)
        )
        assert pos == 0
        assert neg == 0
        assert neu == 0
        assert top_pos == []
        assert top_neg == []
        assert top_neu == []

    def test_counts_match_post_sentiment(self, db, game):
        """Sentiment counts reflect actual post sentiments."""
        from models import SentimentEnum
        day = date(2024, 1, 15)
        for i in range(3):
            _insert_post(db, game.id, SentimentEnum.negative, f"author_{i}", day, f"neg_{i}")
        for i in range(2):
            _insert_post(db, game.id, SentimentEnum.positive, f"pos_author_{i}", day, f"pos_{i}")
        db.commit()

        with patch("services.topic_service.extract_topics_with_metadata", return_value=[]):
            pos, neg, neu, _, _, _ = pss._aggregate_posts_1day(db, game.id, day)

        assert neg == 3
        assert pos == 2
        assert neu == 0


# ── Gate logic tests ──────────────────────────────────────────────────────────

class TestAggregatePosts1DayGate:
    """Relaxed §15 gate: ≥3 posts AND ≥3 authors (no day-span requirement)."""

    def test_cluster_with_enough_posts_and_authors_is_included(self, db, game):
        """A cluster with ≥3 posts and ≥3 authors must appear in top_neg."""
        from models import SentimentEnum
        day = date(2024, 1, 15)
        for i in range(5):
            _insert_post(db, game.id, SentimentEnum.negative, f"user_{i}", day, f"fuel_{i}")
        db.commit()

        fuel_cluster = _make_cluster("fuel + changes + mechanics", post_count=5, author_count=5)
        with patch("services.topic_service.extract_topics_with_metadata",
                   return_value=[fuel_cluster]) as mock_ext:
            pos, neg, neu, top_pos, top_neg, top_neu = pss._aggregate_posts_1day(
                db, game.id, day
            )

        assert "fuel + changes + mechanics" in top_neg, (
            f"Expected fuel cluster in top_neg, got {top_neg}"
        )

    def test_cluster_with_only_2_authors_is_excluded(self, db, game):
        """A cluster with <3 distinct authors must be excluded (§15 author gate)."""
        from models import SentimentEnum
        day = date(2024, 1, 15)
        for i in range(5):
            # Only 2 distinct authors
            author = "alice" if i < 3 else "bob"
            _insert_post(db, game.id, SentimentEnum.positive, author, day, f"few_auth_{i}")
        db.commit()

        cluster_2_authors = _make_cluster("great + game + fun", post_count=5, author_count=2)
        with patch("services.topic_service.extract_topics_with_metadata",
                   return_value=[cluster_2_authors]):
            _, _, _, top_pos, _, _ = pss._aggregate_posts_1day(db, game.id, day)

        assert top_pos == [], (
            f"Cluster with only 2 authors should be excluded, got {top_pos}"
        )

    def test_cluster_with_only_2_posts_is_excluded(self, db, game):
        """A cluster with <3 posts must be excluded."""
        from models import SentimentEnum
        day = date(2024, 1, 15)
        for i in range(3):
            _insert_post(db, game.id, SentimentEnum.negative, f"user_{i}", day, f"low_post_{i}")
        db.commit()

        cluster_2_posts = _make_cluster("crash + bug + fps", post_count=2, author_count=3)
        with patch("services.topic_service.extract_topics_with_metadata",
                   return_value=[cluster_2_posts]):
            _, _, _, _, top_neg, _ = pss._aggregate_posts_1day(db, game.id, day)

        assert top_neg == [], f"Cluster with only 2 posts should be excluded, got {top_neg}"

    def test_multiple_clusters_filtered_correctly(self, db, game):
        """Only clusters passing both post and author thresholds appear."""
        from models import SentimentEnum
        day = date(2024, 1, 15)
        for i in range(6):
            _insert_post(db, game.id, SentimentEnum.negative, f"user_{i}", day, f"multi_{i}")
        db.commit()

        good_cluster = _make_cluster("fuel + nerf + balance", post_count=4, author_count=4)
        bad_cluster_authors = _make_cluster("graphics + quality", post_count=4, author_count=2)
        bad_cluster_posts = _make_cluster("server + lag + ping", post_count=2, author_count=5)

        with patch("services.topic_service.extract_topics_with_metadata",
                   return_value=[good_cluster, bad_cluster_authors, bad_cluster_posts]):
            _, _, _, _, top_neg, _ = pss._aggregate_posts_1day(db, game.id, day)

        assert "fuel + nerf + balance" in top_neg
        assert "graphics + quality" not in top_neg
        assert "server + lag + ping" not in top_neg

    def test_no_day_span_required(self, db, game):
        """A single-day cluster that would fail the ≥2-day-span gate still passes."""
        from models import SentimentEnum
        day = date(2024, 1, 15)
        for i in range(5):
            _insert_post(db, game.id, SentimentEnum.negative, f"user_{i}", day, f"span_{i}")
        db.commit()

        # day_set has only one day — would be excluded by nightly §15 gate
        cluster_single_day = {
            "label": "fuel + changes + revert",
            "post_count": 5,
            "author_ids": {"u1", "u2", "u3", "u4", "u5"},
            "day_set": {"2024-01-15"},  # only one day
        }
        with patch("services.topic_service.extract_topics_with_metadata",
                   return_value=[cluster_single_day]):
            _, _, _, _, top_neg, _ = pss._aggregate_posts_1day(db, game.id, day)

        # The 1-day path MUST NOT enforce day-span; it should pass
        assert "fuel + changes + revert" in top_neg, (
            "Single-day cluster should pass the relaxed §15 gate for 1-day windows"
        )

    def test_top_n_cap(self, db, game):
        """Only up to _1DAY_TOP_TOPICS topics per sentiment bucket are returned.
        Raised 2026-06-24 from 5 → 8 to give the LLM more signal handles."""
        from models import SentimentEnum
        day = date(2024, 1, 15)
        for i in range(15):
            _insert_post(db, game.id, SentimentEnum.positive, f"user_{i}", day, f"cap_{i}")
        db.commit()

        # 12 clusters that all pass the gate
        clusters = [
            _make_cluster(f"topic_{i} + game + fun", post_count=3 + i, author_count=3)
            for i in range(12)
        ]
        with patch("services.topic_service.extract_topics_with_metadata", return_value=clusters):
            _, _, _, top_pos, _, _ = pss._aggregate_posts_1day(db, game.id, day)

        assert len(top_pos) <= pss._1DAY_TOP_TOPICS, (
            f"Expected ≤{pss._1DAY_TOP_TOPICS} topics, got {len(top_pos)}"
        )

    def test_ordering_by_post_count_descending(self, db, game):
        """Topics are returned ordered by post_count descending."""
        from models import SentimentEnum
        day = date(2024, 1, 15)
        for i in range(10):
            _insert_post(db, game.id, SentimentEnum.negative, f"user_{i}", day, f"order_{i}")
        db.commit()

        clusters = [
            _make_cluster("minor + issue", post_count=3, author_count=3),
            _make_cluster("major + bug + crash", post_count=8, author_count=6),
            _make_cluster("medium + problem", post_count=5, author_count=4),
        ]
        with patch("services.topic_service.extract_topics_with_metadata", return_value=clusters):
            _, _, _, _, top_neg, _ = pss._aggregate_posts_1day(db, game.id, day)

        assert top_neg[0] == "major + bug + crash", (
            f"Highest post_count should be first; got {top_neg}"
        )


# ── Defensive behavior ────────────────────────────────────────────────────────

class TestAggregatePosts1DayDefensive:
    """_aggregate_posts_1day must be robust to topic_service failures."""

    def test_topic_service_exception_returns_empty_lists(self, db, game):
        """If topic_service raises, log and return empty topic lists (don't crash)."""
        from models import SentimentEnum
        day = date(2024, 1, 15)
        for i in range(5):
            _insert_post(db, game.id, SentimentEnum.negative, f"user_{i}", day, f"exc_{i}")
        db.commit()

        with patch("services.topic_service.extract_topics_with_metadata",
                   side_effect=RuntimeError("clustering failed")):
            pos, neg, neu, top_pos, top_neg, top_neu = pss._aggregate_posts_1day(
                db, game.id, day
            )

        # Counts should still be correct, topics empty
        assert neg == 5
        assert top_neg == []
        assert top_pos == []
        assert top_neu == []

    def test_distinct_sentiment_buckets_are_independent(self, db, game):
        """Positive, negative, neutral topic extractions are called independently."""
        from models import SentimentEnum
        day = date(2024, 1, 15)
        for i in range(3):
            _insert_post(db, game.id, SentimentEnum.positive, f"pos_u_{i}", day, f"indep_pos_{i}")
        for i in range(3):
            _insert_post(db, game.id, SentimentEnum.negative, f"neg_u_{i}", day, f"indep_neg_{i}")
        db.commit()

        pos_cluster = _make_cluster("great + gameplay + fun", post_count=3, author_count=3)
        neg_cluster = _make_cluster("crash + bug + fps", post_count=3, author_count=3)

        call_count = [0]
        def side_effect(texts, author_ids, day_ids):
            call_count[0] += 1
            # Return different clusters depending on which bucket is being processed
            if any("fun" in t or "great" in t or "gameplay" in t for t in texts):
                return [pos_cluster]
            return [neg_cluster]

        with patch("services.topic_service.extract_topics_with_metadata",
                   side_effect=side_effect):
            _, _, _, top_pos, top_neg, _ = pss._aggregate_posts_1day(db, game.id, day)

        # Both sentiment buckets should have been processed
        assert call_count[0] == 2


# ── generate_window_summary integration ──────────────────────────────────────

class TestGenerateWindowSummaryUsing1DayPath:
    """generate_window_summary(days=1) must call _aggregate_posts_1day, not _aggregate_posts."""

    def test_days1_calls_1day_helper_not_standard(self, db, game):
        """When days=1, the 1-day helper is called instead of _aggregate_posts."""
        with (
            patch.object(pss, "_aggregate_posts_1day",
                         return_value=(5, 3, 2, ["Gameplay"], ["Fuel Changes"], [])) as mock_1day,
            patch.object(pss, "_aggregate_posts") as mock_std,
            patch.object(pss, "_call_claude_for_period",
                         return_value=("summary", None, [], {})),
        ):
            from models import RawPost, SourceEnum, SentimentRecord, SentimentEnum
            from datetime import datetime
            today = date.today()
            post = RawPost(
                game_id=game.id,
                source=SourceEnum.steam_review,
                external_id="ws_test_001",
                author="tester",
                title="Test",
                body="Test body",
                url="https://example.com/ws_test_001",
                upvotes=1,
                collected_at=datetime.combine(today, datetime.min.time()),
                post_date=datetime.combine(today, datetime.min.time()),
            )
            db.add(post)
            db.flush()
            sr = SentimentRecord(
                raw_post_id=post.id,
                sentiment=SentimentEnum.positive,
                sentiment_score=0.9,
                topics=[],
            )
            db.add(sr)
            db.commit()

            pss.generate_window_summary(db, game.id, days=1)

        mock_1day.assert_called_once()
        mock_std.assert_not_called()

    def test_days7_calls_standard_helper_not_1day(self, db, game):
        """When days=7, _aggregate_posts is called instead of _aggregate_posts_1day."""
        with (
            patch.object(pss, "_aggregate_posts_1day") as mock_1day,
            patch.object(pss, "_aggregate_posts",
                         return_value=(5, 3, 2, ["Gameplay"], ["Fuel Changes"], [])) as mock_std,
            patch.object(pss, "_call_claude_for_period",
                         return_value=("summary", None, [], {})),
        ):
            from models import RawPost, SourceEnum, SentimentRecord, SentimentEnum
            from datetime import datetime
            today = date.today()
            post = RawPost(
                game_id=game.id,
                source=SourceEnum.steam_review,
                external_id="ws_test_7d_001",
                author="tester7",
                title="7-day test",
                body="7-day body",
                url="https://example.com/ws_test_7d_001",
                upvotes=1,
                collected_at=datetime.combine(today, datetime.min.time()),
                post_date=datetime.combine(today, datetime.min.time()),
            )
            db.add(post)
            db.flush()
            sr = SentimentRecord(
                raw_post_id=post.id,
                sentiment=SentimentEnum.positive,
                sentiment_score=0.9,
                topics=[],
            )
            db.add(sr)
            db.commit()

            pss.generate_window_summary(db, game.id, days=7)

        mock_1day.assert_not_called()
        mock_std.assert_called_once()
