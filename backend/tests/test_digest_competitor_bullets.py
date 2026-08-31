"""Regression tests for the Competitive Set feature in weekly + monthly digests.

Feature: 2026-08-30 (Steve request).
Revised same day (evening): chart PNG + short caption + topic-momentum
bullets, replacing the paragraph-length per-competitor volume bullets.

Contract locked in by this test file:

  1. When a parent title has no rows in competitor_games, TitleBlock
     .competitor_bullets is None and no "Competitive Set" section renders.
  2. When a parent has 1+ competitors, the FIRST bullet is always a chart
     bundle ({kind: 'chart', chart_data_uri, html: caption}). The caption
     summarises aggregate volume in ONE sentence — no per-competitor
     driver-hypothesis repetition.
  3. Every subsequent bullet is a topic-momentum sentence for ONE competitor
     (max _COMPETITOR_MAX_FEATURED featured). Each leads with the
     competitor NAME in <strong> then describes what specific topics have
     positive/negative momentum this week.
  4. Generic topic labels ("General Discussion", "General Positive
     Sentiment", etc.) are filtered out via _is_specific_topic so the
     bullets surface concrete hooks.
  5. Rendered HTML contains the word "neutral" ZERO times — commentary
     stays tilted toward pos/neg per Steve's "less neutral" ask.
  6. When both TopicTrend and WindowSummary.top_*_topics have nothing
     specific for a competitor, the topic bullet emits a stance-only
     fallback so the reader still knows where the peer stands.
"""
from datetime import date, timedelta
from unittest.mock import MagicMock

import pytest

from services.digest_service import (
    _COMPETITOR_MAX_FEATURED,
    _build_competitor_bullets,
    _competitor_topic_sentence,
    _describe_ratio_stance,
    _is_specific_topic,
    _render_competitive_set,
    _volume_caption_sentence,
    _weighted_pos_neg_score,
    TitleBlock,
)


# ── Pure helpers ─────────────────────────────────────────────────────────────

class TestIsSpecificTopic:
    def test_none_and_empty(self):
        assert _is_specific_topic(None) is False
        assert _is_specific_topic("") is False
        assert _is_specific_topic("   ") is False

    def test_generic_labels_rejected(self):
        for lbl in [
            "General Discussion",
            "general discussion",
            "General Positive Sentiment",
            "General Gameplay Talk",
            "Discussion",
            "Other",
            "N/A",
        ]:
            assert _is_specific_topic(lbl) is False, lbl

    def test_specific_labels_accepted(self):
        for lbl in [
            "Halloween Content Posts",
            "Killer Gameplay",
            "Silent Hill Franchise",
            "Halloween 20 Amazon",
            "Survivor Gameplay",
        ]:
            assert _is_specific_topic(lbl) is True, lbl

    def test_case_insensitive_and_whitespace_tolerant(self):
        assert _is_specific_topic("  GENERAL DISCUSSION  ") is False
        assert _is_specific_topic("  Killer Gameplay  ") is True


class TestWeightedPosNegScore:
    def test_zero_when_no_evidence(self):
        assert _weighted_pos_neg_score(0, 0) == 0.0

    def test_positive_when_positives_dominate(self):
        assert _weighted_pos_neg_score(10, 2) == pytest.approx(0.6667, rel=1e-3)

    def test_negative_when_negatives_dominate(self):
        assert _weighted_pos_neg_score(2, 10) == pytest.approx(-0.6667, rel=1e-3)


class TestDescribeRatioStance:
    def test_no_signal(self):
        assert "no qualifying pos/neg signal" in _describe_ratio_stance(0, 0)

    def test_unblemished_positive(self):
        s = _describe_ratio_stance(15, 0)
        assert "unblemished" in s and "15:0" in s

    def test_strongly_positive(self):
        assert "strongly positive" in _describe_ratio_stance(50, 5)

    def test_leans_positive(self):
        assert "leans positive" in _describe_ratio_stance(20, 10)

    def test_balanced(self):
        assert "roughly balanced" in _describe_ratio_stance(10, 9)

    def test_leans_negative(self):
        assert "leans negative" in _describe_ratio_stance(10, 20)

    def test_strongly_negative(self):
        assert "strongly negative" in _describe_ratio_stance(5, 50)

    def test_never_surfaces_neutral(self):
        for pos, neg in [(0, 0), (10, 0), (0, 10), (5, 5), (100, 3), (3, 100)]:
            assert "neutral" not in _describe_ratio_stance(pos, neg).lower()


# ── Aggregate volume caption ─────────────────────────────────────────────────

class TestVolumeCaptionSentence:
    def test_empty_comps(self):
        assert _volume_caption_sentence("P", 100, []) == ""

    def test_parent_zero_comps_active(self):
        s = _volume_caption_sentence(
            "P", 0, [{"total_posts": 500}, {"total_posts": 300}],
        )
        assert "500" in s or "800" in s
        assert "no qualifying signal for the Saber title" in s

    def test_big_gap_uses_fold_notation(self):
        s = _volume_caption_sentence(
            "P", 100, [{"total_posts": 500}, {"total_posts": 700}],
        )
        # 1200 / 100 = 12.0×
        assert "×" in s
        assert "12" in s or "12.0" in s
        # Only ONE sentence total (no repeated clause)
        # Rough proxy: single terminal period, or up to a couple.
        assert s.count(". ") <= 1

    def test_on_par(self):
        s = _volume_caption_sentence(
            "P", 1000, [{"total_posts": 500}, {"total_posts": 500}],
        )
        assert "on par" in s or "similar" in s or "1,000" in s

    def test_never_mentions_neutral(self):
        s = _volume_caption_sentence(
            "P", 100, [{"total_posts": 500}, {"total_posts": 700}],
        )
        assert "neutral" not in s.lower()


# ── Topic momentum sentence ──────────────────────────────────────────────────

def _mk_topic(label, sentiment_str, velocity=0.5, mention_count=10,
              trend_direction_str="rising"):
    t = MagicMock()
    t.topic_label = label
    t.velocity = velocity
    t.mention_count = mention_count
    # Enum-like objects have .value; support that path
    sentiment_mock = MagicMock()
    sentiment_mock.value = sentiment_str
    t.sentiment = sentiment_mock
    trend_mock = MagicMock()
    trend_mock.value = trend_direction_str
    t.trend_direction = trend_mock
    return t


class TestCompetitorTopicSentence:
    def _mk_db(self, trend_rows):
        db = MagicMock()
        q = MagicMock()
        q.filter.return_value.all.return_value = trend_rows
        db.query.return_value = q
        return db

    def test_positive_and_negative_topic_packed_into_one_bullet(self):
        trend = [
            _mk_topic("Killer Gameplay", "negative", velocity=0.9,
                      mention_count=20, trend_direction_str="rising"),
            _mk_topic("Halloween Content Posts", "positive", velocity=0.7,
                      mention_count=15, trend_direction_str="rising"),
            _mk_topic("General Discussion", "positive", velocity=5.0,
                      mention_count=100),  # generic — filtered
        ]
        db = self._mk_db(trend)
        row = MagicMock()
        row.top_positive_topics = []
        row.top_negative_topics = []
        row.positive_count = 30
        row.negative_count = 15

        s = _competitor_topic_sentence(
            db, competitor_id=140, competitor_name="Halloween: The Game",
            week_start=date(2026, 8, 24), row=row,
        )
        assert "<strong>Halloween: The Game</strong>" in s
        assert "Halloween Content Posts" in s
        assert "Killer Gameplay" in s
        assert "General Discussion" not in s
        assert "positive momentum" in s
        assert "negative pressure" in s
        # Never says "neutral"
        assert "neutral" not in s.lower()

    def test_rising_marker_only_when_velocity_high(self):
        trend = [
            _mk_topic("Halloween Content Posts", "positive", velocity=0.15,
                      trend_direction_str="stable"),
        ]
        db = self._mk_db(trend)
        row = MagicMock()
        row.top_positive_topics = []
        row.top_negative_topics = []
        row.positive_count = 5
        row.negative_count = 1
        s = _competitor_topic_sentence(
            db, 140, "Halloween: The Game", date(2026, 8, 24), row,
        )
        assert "Halloween Content Posts" in s
        # velocity 0.15 < 0.5 → no rising marker
        assert "(rising)" not in s

    def test_falls_back_to_window_summary_top_topics(self):
        # No TopicTrend rows → use row.top_positive_topics fallback
        db = self._mk_db([])
        row = MagicMock()
        row.top_positive_topics = ["General Discussion", "Halloween Builds"]
        row.top_negative_topics = ["General Gameplay Talk", "Killer Gameplay"]
        row.positive_count = 10
        row.negative_count = 5
        s = _competitor_topic_sentence(
            db, 140, "Halloween: The Game", date(2026, 8, 24), row,
        )
        assert "Halloween Builds" in s  # first specific label
        assert "Killer Gameplay" in s
        # Generic labels skipped
        assert "General Discussion" not in s

    def test_no_specific_topic_falls_back_to_stance(self):
        db = self._mk_db([])
        row = MagicMock()
        row.top_positive_topics = ["General Discussion"]
        row.top_negative_topics = ["General Gameplay Talk"]
        row.positive_count = 3
        row.negative_count = 8
        s = _competitor_topic_sentence(
            db, 140, "Halloween: The Game", date(2026, 8, 24), row,
        )
        assert "leans negative" in s
        assert "no specific topic momentum" in s


# ── End-to-end build with mocked DB ──────────────────────────────────────────

class TestBuildCompetitorBullets:
    def test_returns_none_when_no_competitors(self):
        db = MagicMock()
        db.query.return_value.filter_by.return_value.all.return_value = []
        out = _build_competitor_bullets(
            db,
            parent_game_id=999,
            parent_positive=100, parent_negative=20, parent_total=500,
            parent_name="Parent",
            period="weekly",
            today=date(2026, 8, 30),
        )
        assert out is None

    def test_first_bullet_is_chart_kind(self, monkeypatch):
        # Minimal mock DB: 1 competitor, no window summary data
        db = MagicMock()
        cgame = MagicMock()
        cgame.id = 140
        cgame.name = "Halloween: The Game"
        link = MagicMock()
        link.competitor = cgame

        # Track which queries have been made so we can return the right
        # shape each time. There are many queries: CompetitorGame,
        # WindowSummary, TopicTrend, DailySummary.
        query_state = {"i": 0}

        def _query(model):
            q = MagicMock()
            name = getattr(model, "__name__", str(model))
            if name.endswith("CompetitorGame"):
                q.filter_by.return_value.all.return_value = [link]
            elif name.endswith("WindowSummary"):
                # Return a stubbed WindowSummary row
                row = MagicMock()
                row.positive_count = 100
                row.negative_count = 40
                row.neutral_count = 30
                row.total_posts = 170
                row.top_positive_topics = ["Halloween Content Posts"]
                row.top_negative_topics = ["Killer Gameplay"]
                q.filter_by.return_value.first.return_value = row
            elif name.endswith("TopicTrend"):
                q.filter.return_value.all.return_value = []
            elif name.endswith("DailySummary"):
                # Series loader queries DailySummary via .filter(...).all()
                q.filter.return_value.all.return_value = []
            else:
                q.filter.return_value.all.return_value = []
                q.filter_by.return_value.first.return_value = None
            return q

        db.query.side_effect = _query

        out = _build_competitor_bullets(
            db,
            parent_game_id=21,
            parent_positive=10, parent_negative=2, parent_total=20,
            parent_name="Hellraiser Revival",
            period="weekly",
            today=date(2026, 8, 30),
        )
        assert out is not None and len(out) >= 2
        assert out[0]["kind"] == "chart"
        # Chart URI may be empty (matplotlib fails in test) but the caption must exist
        assert "html" in out[0]
        # At least one topic bullet
        topic_bullets = [b for b in out[1:] if b.get("kind") == "topic"]
        assert len(topic_bullets) >= 1
        assert "<strong>Halloween: The Game</strong>" in topic_bullets[0]["html"]


class TestRenderCompetitiveSet:
    def test_empty_when_no_bullets(self):
        b = TitleBlock(
            game_id=1, name="X", total_posts=0,
            positive=0, negative=0, neutral=0,
            pos_neg_ratio="no signal",
            executive_summary="", recommended_actions="", bold_ideas=[],
            period_label="", has_data=False,
        )
        assert _render_competitive_set(b) == ""

    def test_empty_when_bullets_is_none(self):
        b = TitleBlock(
            game_id=1, name="X", total_posts=100,
            positive=50, negative=20, neutral=30,
            pos_neg_ratio="2.5:1",
            executive_summary="", recommended_actions="", bold_ideas=[],
            period_label="", has_data=True,
            competitor_bullets=None,
        )
        assert _render_competitive_set(b) == ""

    def test_renders_img_and_bullets(self):
        b = TitleBlock(
            game_id=1, name="X", total_posts=100,
            positive=50, negative=20, neutral=30,
            pos_neg_ratio="2.5:1",
            executive_summary="", recommended_actions="", bold_ideas=[],
            period_label="", has_data=True,
            competitor_bullets=[
                {
                    "kind": "chart",
                    "chart_data_uri": "data:image/png;base64,AAAA",
                    "html": "Peer set generated 500 posts, 5× the Saber title's 100.",
                },
                {
                    "kind": "topic",
                    "competitor_id": 2, "competitor_name": "C1",
                    "html": "<strong>C1</strong> — positive momentum on <em>X</em>.",
                },
            ],
        )
        html_out = _render_competitive_set(b)
        assert "Competitive Set" in html_out
        assert '<img src="data:image/png;base64,AAAA"' in html_out
        assert 'alt="4-week post volume' in html_out
        assert '<p ' in html_out and "5× the Saber title" in html_out
        assert "<strong>C1</strong>" in html_out
        assert "<ul" in html_out and "</ul>" in html_out

    def test_renders_without_chart_when_uri_empty(self):
        # Chart render failed → no <img> but caption + bullets still render.
        b = TitleBlock(
            game_id=1, name="X", total_posts=100,
            positive=50, negative=20, neutral=30,
            pos_neg_ratio="2.5:1",
            executive_summary="", recommended_actions="", bold_ideas=[],
            period_label="", has_data=True,
            competitor_bullets=[
                {"kind": "chart", "chart_data_uri": "",
                 "html": "Peer set generated 500 posts."},
                {"kind": "topic", "competitor_id": 2, "competitor_name": "C1",
                 "html": "<strong>C1</strong> — leans positive."},
            ],
        )
        html_out = _render_competitive_set(b)
        assert "<img" not in html_out
        assert "Peer set generated 500 posts" in html_out
        assert "<strong>C1</strong>" in html_out

    def test_never_surfaces_neutral(self):
        # Even when the underlying data has neutrals, rendered HTML never
        # exposes the word 'neutral' — enforces the "less neutral" contract.
        b = TitleBlock(
            game_id=1, name="X", total_posts=100,
            positive=50, negative=20, neutral=30,
            pos_neg_ratio="2.5:1",
            executive_summary="", recommended_actions="", bold_ideas=[],
            period_label="", has_data=True,
            competitor_bullets=[
                {"kind": "chart", "chart_data_uri": "",
                 "html": "Peer set generated 500 posts."},
                {"kind": "topic", "competitor_id": 2, "competitor_name": "C1",
                 "html": "<strong>C1</strong> — positive momentum on <em>Kills</em>; "
                         "negative pressure on <em>Perks</em>."},
            ],
        )
        assert "neutral" not in _render_competitive_set(b).lower()
