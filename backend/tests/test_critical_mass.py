"""
Tests for §15 critical-mass gate.

CLAUDE.md §15: A topic must have ≥3 distinct posts, ≥3 distinct authors, AND
presence across ≥2 distinct days before it surfaces in any user-facing output.

The total-volume gate (< 20 substantive posts) also lives here:
  - < 20 posts in the window → insufficient-signal sentinel, no Claude call.
  - ≥ 20 posts → normal path (Claude called).

Tests use:
  - services.topic_service.extract_topics_with_metadata  (cluster-level metadata)
  - services.period_summary_service._call_claude_for_period  (volume gate)
  - services.ingestor._CM_MIN_POSTS / _CM_MIN_AUTHORS / _CM_MIN_DAYS  (constants)
"""
import pytest
from unittest.mock import patch, MagicMock

from services import period_summary_service as pss
from services.topic_service import extract_topics_with_metadata
import services.ingestor as ingestor_module


# ── Threshold constant sanity checks ─────────────────────────────────────────

class TestThresholdConstants:
    def test_min_posts_is_3(self):
        assert ingestor_module._CM_MIN_POSTS == 3

    def test_min_authors_is_3(self):
        assert ingestor_module._CM_MIN_AUTHORS == 3

    def test_min_days_is_2(self):
        assert ingestor_module._CM_MIN_DAYS == 2

    def test_period_summary_min_posts_is_20(self):
        assert pss._MIN_SUBSTANTIVE_POSTS == 20


# ── Cluster-metadata unit tests ───────────────────────────────────────────────

class TestExtractTopicsWithMetadata:
    """
    Tests for extract_topics_with_metadata — validates the metadata structure
    returned by the function in normal conditions.

    We run these tests in lightweight-NLP mode (LDA only) so they don't require
    BERTopic / CUDA and run quickly.  Since `settings` is imported lazily inside
    helper functions, we patch `config.settings` directly.
    """

    def _run_with_lda(self, texts, author_ids, day_ids):
        """Helper: run extract_topics_with_metadata with LDA forced."""
        # Patch config.settings so the lazy `from config import settings` inside
        # the helper functions sees lightweight_nlp=True.
        import config
        original = config.settings.lightweight_nlp
        config.settings.lightweight_nlp = True
        try:
            return extract_topics_with_metadata(texts, author_ids, day_ids)
        finally:
            config.settings.lightweight_nlp = original

    def test_returns_empty_for_too_few_texts(self):
        """Fewer than 3 texts → empty list (cannot form meaningful clusters)."""
        texts = [
            "This game has great combat mechanics and controls",
            "Really enjoy the gameplay loop and progression",
        ]
        result = self._run_with_lda(texts, ["alice", "bob"], ["2024-01-01", "2024-01-02"])
        assert result == []

    def test_returns_list_of_dicts(self):
        """With enough texts, returns list of dicts with required keys."""
        # Enough similar texts to form a cluster
        texts = [
            "The combat in this game is absolutely fantastic and well designed",
            "Combat mechanics are polished and satisfying to execute in game",
            "Great combat system with smooth controls and responsive gameplay",
            "I love the combat in this game it feels so rewarding to master",
            "Combat feel is excellent and really sets this game apart from others",
        ]
        author_ids = ["alice", "bob", "carol", "dave", "eve"]
        day_ids = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]

        result = self._run_with_lda(texts, author_ids, day_ids)

        assert isinstance(result, list)
        for item in result:
            assert "label" in item
            assert "post_count" in item
            assert "author_ids" in item
            assert "day_set" in item
            assert isinstance(item["post_count"], int)
            assert isinstance(item["author_ids"], set)
            assert isinstance(item["day_set"], set)

    def test_post_count_is_positive(self):
        """Every returned cluster has at least 1 post."""
        texts = [
            "Performance issues with framerate drops and stuttering in game",
            "The game stutters constantly and performance is really poor",
            "Terrible performance and lots of framerate issues throughout the game",
            "Game keeps dropping frames and the performance is unacceptable",
            "Performance needs a serious patch the game runs badly on PC",
        ]
        author_ids = ["u1", "u2", "u3", "u4", "u5"]
        day_ids = ["2024-01-01"] * 5

        result = self._run_with_lda(texts, author_ids, day_ids)

        for item in result:
            assert item["post_count"] >= 1


# ── Critical-mass gate simulation ────────────────────────────────────────────

class TestCriticalMassGate:
    """
    Tests that simulate the §15 gate logic directly.

    The gate lives in _step6_extract_topics (ingestor.py). We test its
    threshold logic by constructing cluster dicts and applying the gate
    conditions directly.
    """

    def _apply_gate(self, cluster: dict) -> bool:
        """Apply the §15 critical-mass gate to a single cluster dict."""
        pc = cluster["post_count"]
        ac = len(cluster["author_ids"])
        dc = len(cluster["day_set"])
        return (
            pc >= ingestor_module._CM_MIN_POSTS
            and ac >= ingestor_module._CM_MIN_AUTHORS
            and dc >= ingestor_module._CM_MIN_DAYS
        )

    def test_3_posts_3_authors_2_days_passes(self):
        """Exactly meeting the minimum thresholds → passes."""
        cluster = {
            "label": "Performance Issues",
            "post_count": 3,
            "author_ids": {"alice", "bob", "carol"},
            "day_set": {"2024-01-01", "2024-01-02"},
        }
        assert self._apply_gate(cluster) is True

    def test_5_posts_1_author_fails_author_monoculture(self):
        """5 posts from a single author → author monoculture → fails."""
        cluster = {
            "label": "General Discussion",
            "post_count": 5,
            "author_ids": {"spammer_user"},  # only 1 author
            "day_set": {"2024-01-01", "2024-01-02", "2024-01-03"},
        }
        assert self._apply_gate(cluster) is False, (
            "5 posts from 1 author should fail the author-diversity threshold."
        )

    def test_3_posts_3_authors_1_day_fails_spike(self):
        """3 posts, 3 authors, but all on 1 day → single-day spike → fails."""
        cluster = {
            "label": "Launch Day Excitement",
            "post_count": 3,
            "author_ids": {"alice", "bob", "carol"},
            "day_set": {"2024-01-01"},  # only 1 day
        }
        assert self._apply_gate(cluster) is False, (
            "3 posts on 1 day should fail the multi-day threshold (spike rejection)."
        )

    def test_2_posts_fails_post_count(self):
        """Only 2 posts → fails the post count threshold."""
        cluster = {
            "label": "Minor Issue",
            "post_count": 2,
            "author_ids": {"alice", "bob", "carol"},
            "day_set": {"2024-01-01", "2024-01-02"},
        }
        assert self._apply_gate(cluster) is False

    def test_2_authors_fails_author_threshold(self):
        """3 posts, only 2 distinct authors → fails."""
        cluster = {
            "label": "Gameplay Feedback",
            "post_count": 3,
            "author_ids": {"alice", "bob"},  # only 2 authors
            "day_set": {"2024-01-01", "2024-01-02"},
        }
        assert self._apply_gate(cluster) is False

    def test_generous_cluster_well_above_threshold_passes(self):
        """A cluster well above thresholds → passes."""
        cluster = {
            "label": "Combat Mechanics",
            "post_count": 20,
            "author_ids": {"u1", "u2", "u3", "u4", "u5", "u6", "u7"},
            "day_set": {"2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"},
        }
        assert self._apply_gate(cluster) is True

    def test_exactly_threshold_passes(self):
        """post_count=3, authors=3, days=2 → passes (exactly meeting minimums)."""
        cluster = {
            "label": "Borderline Topic",
            "post_count": 3,
            "author_ids": {"x", "y", "z"},
            "day_set": {"d1", "d2"},
        }
        assert self._apply_gate(cluster) is True

    def test_one_below_each_threshold_fails(self):
        """post_count=2, authors=2, days=1 → fails all three."""
        cluster = {
            "label": "Very Small Signal",
            "post_count": 2,
            "author_ids": {"a", "b"},
            "day_set": {"d1"},
        }
        assert self._apply_gate(cluster) is False


# ── Total-volume gate (insufficient-signal sentinel) ─────────────────────────

class TestInsufficientSignalSentinel:
    """
    Tests for §15 total-volume gate in _call_claude_for_period:
    < 20 posts → sentinel returned, no Claude call.
    ≥ 20 posts → normal path (Claude would be called).
    """

    def test_15_posts_triggers_sentinel_no_claude(self):
        """With only 15 posts, the sentinel is returned and Claude is NOT called."""
        with patch.object(pss, "_get_client") as mock_get_client:
            exec_summary, rec_actions, bold_ideas = pss._call_claude_for_period(
                game_name="Test Game",
                window_label="January 2024",
                pos_topics=["Combat", "Story"],
                neg_topics=["Performance"],
                neu_topics=["Updates"],
                total_posts=15,
            )

        # Claude client must NOT have been consulted
        mock_get_client.assert_not_called()

        # Sentinel output checks
        assert "Insufficient signal" in exec_summary
        assert "15" in exec_summary, "Sentinel must include the actual post count."
        assert rec_actions is None, "Recommended actions must be None for sentinel."
        assert bold_ideas == [], "Bold ideas must be empty for sentinel."

    def test_0_posts_triggers_sentinel(self):
        """0 posts → sentinel."""
        with patch.object(pss, "_get_client") as mock_get_client:
            exec_summary, rec_actions, bold_ideas = pss._call_claude_for_period(
                game_name="Test Game",
                window_label="February 2024",
                pos_topics=[],
                neg_topics=[],
                neu_topics=[],
                total_posts=0,
            )
        mock_get_client.assert_not_called()
        assert "Insufficient signal" in exec_summary
        assert "0" in exec_summary
        assert rec_actions is None
        assert bold_ideas == []

    def test_19_posts_triggers_sentinel(self):
        """19 posts → sentinel (one below threshold)."""
        with patch.object(pss, "_get_client") as mock_get_client:
            exec_summary, rec_actions, bold_ideas = pss._call_claude_for_period(
                game_name="Test Game",
                window_label="March 2024",
                pos_topics=["Gameplay"],
                neg_topics=["Bugs"],
                neu_topics=[],
                total_posts=19,
            )
        mock_get_client.assert_not_called()
        assert "Insufficient signal" in exec_summary
        assert rec_actions is None
        assert bold_ideas == []

    def test_20_posts_uses_normal_path(self):
        """
        20 posts (exactly at threshold) → normal path: _get_client is called.
        We return None from the client factory so no actual Claude call is made.
        """
        with patch.object(pss, "_get_client", return_value=None) as mock_get_client:
            exec_summary, rec_actions, bold_ideas = pss._call_claude_for_period(
                game_name="Test Game",
                window_label="April 2024",
                pos_topics=["Gameplay"],
                neg_topics=["Bugs"],
                neu_topics=["Updates"],
                total_posts=20,
            )
        # _get_client must have been called (normal path entered)
        mock_get_client.assert_called_once()
        # Since client is None, placeholder summary is returned (not sentinel)
        assert "Insufficient signal" not in exec_summary

    def test_25_posts_uses_normal_path(self):
        """25 posts → normal path, not sentinel."""
        with patch.object(pss, "_get_client", return_value=None) as mock_get_client:
            exec_summary, rec_actions, bold_ideas = pss._call_claude_for_period(
                game_name="Test Game",
                window_label="May 2024",
                pos_topics=["Gameplay", "Graphics"],
                neg_topics=["Performance"],
                neu_topics=["Balance"],
                total_posts=25,
            )
        mock_get_client.assert_called_once()
        assert "Insufficient signal" not in exec_summary

    def test_100_posts_uses_normal_path(self):
        """100 posts → clearly above threshold → normal path."""
        with patch.object(pss, "_get_client", return_value=None) as mock_get_client:
            exec_summary, _actions, _ideas = pss._call_claude_for_period(
                game_name="Busy Game",
                window_label="June 2024",
                pos_topics=["Story", "Combat"],
                neg_topics=["Bugs"],
                neu_topics=["Updates"],
                total_posts=100,
            )
        mock_get_client.assert_called_once()
        assert "Insufficient signal" not in exec_summary


# ── Sentinel format validation ────────────────────────────────────────────────

class TestSentinelFormat:
    """Validate the exact format of the insufficient-signal sentinel string."""

    def test_sentinel_contains_post_count(self):
        """Sentinel must include the exact number of posts."""
        with patch.object(pss, "_get_client"):
            exec_summary, _, _ = pss._call_claude_for_period(
                game_name="A Game",
                window_label="Test Window",
                pos_topics=[],
                neg_topics=[],
                neu_topics=[],
                total_posts=7,
            )
        assert "7" in exec_summary

    def test_sentinel_mentions_substantive_posts(self):
        """Sentinel message should mention 'substantive posts' per spec."""
        with patch.object(pss, "_get_client"):
            exec_summary, _, _ = pss._call_claude_for_period(
                game_name="A Game",
                window_label="Test Window",
                pos_topics=[],
                neg_topics=[],
                neu_topics=[],
                total_posts=12,
            )
        assert "substantive posts" in exec_summary

    def test_sentinel_rec_actions_is_none(self):
        """recommended_actions must be None (not empty string, not placeholder)."""
        with patch.object(pss, "_get_client"):
            _exec, rec_actions, _ideas = pss._call_claude_for_period(
                game_name="A Game",
                window_label="Test Window",
                pos_topics=[],
                neg_topics=[],
                neu_topics=[],
                total_posts=5,
            )
        assert rec_actions is None

    def test_sentinel_bold_ideas_is_empty_list(self):
        """bold_ideas must be [] (not None)."""
        with patch.object(pss, "_get_client"):
            _exec, _actions, bold_ideas = pss._call_claude_for_period(
                game_name="A Game",
                window_label="Test Window",
                pos_topics=[],
                neg_topics=[],
                neu_topics=[],
                total_posts=5,
            )
        assert bold_ideas == []
        assert isinstance(bold_ideas, list)
