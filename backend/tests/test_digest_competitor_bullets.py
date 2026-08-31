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
    _TOPIC_ABSOLUTE_FLOOR,
    _TOPIC_RELATIVE_FLOOR,
    _build_competitor_bullets,
    _competitor_topic_sentence,
    _competitor_volume_bullet,
    _describe_ratio_stance,
    _is_blocked_for_game,
    _is_specific_topic,
    _passes_topic_floor,
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


class TestTopicFloor:
    def test_absolute_floor_blocks_fringe_topics(self):
        # 2 mentions is way below the absolute floor even at zero-total title
        assert _passes_topic_floor(2, 0) is False
        # 4 still fails
        assert _passes_topic_floor(4, 0) is False
        # 5 passes when parent total is 0 (only absolute floor applies)
        assert _passes_topic_floor(5, 0) is True

    def test_relative_floor_blocks_low_share_topics(self):
        # Halloween-style case: 2 mentions vs 10,669 total is 0.019%
        assert _passes_topic_floor(2, 10_669) is False
        # Even 50 mentions is only 0.47% — still below
        assert _passes_topic_floor(50, 10_669) is False
        # 108 mentions is 1.01% — passes
        assert _passes_topic_floor(108, 10_669) is True

    def test_both_floors_must_be_met(self):
        # Absolute floor 5, relative floor 1%
        assert _passes_topic_floor(3, 100) is False  # abs
        assert _passes_topic_floor(5, 10000) is False  # rel (0.05%)
        assert _passes_topic_floor(5, 100) is True   # both cleared


class TestPerGameBlocklist:
    def test_halloween_theme_park_event_blocked(self):
        # "Halloween Nights Horror" is Universal Studios theme-park event
        assert _is_blocked_for_game("Halloween Nights Horror", 140) is True
        assert _is_blocked_for_game("Halloween Horror Nights", 140) is True

    def test_case_and_whitespace_insensitive(self):
        assert _is_blocked_for_game("  halloween nights horror  ", 140) is True
        assert _is_blocked_for_game("HALLOWEEN NIGHTS HORROR", 140) is True

    def test_only_applies_to_that_game(self):
        # A different game (say Silent Hill: Townfall, id=139) doesn't
        # inherit Halloween's blocklist.
        assert _is_blocked_for_game("Halloween Nights Horror", 139) is False

    def test_unrelated_labels_pass(self):
        assert _is_blocked_for_game("Killer Gameplay", 140) is False
        assert _is_blocked_for_game("Michael Myers", 140) is False


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
                      mention_count=200, trend_direction_str="rising"),
            _mk_topic("Halloween Content Posts", "positive", velocity=0.7,
                      mention_count=150, trend_direction_str="rising"),
            _mk_topic("General Discussion", "positive", velocity=5.0,
                      mention_count=1000),  # generic — filtered
        ]
        db = self._mk_db(trend)
        row = MagicMock()
        row.top_positive_topics = []
        row.top_negative_topics = []
        row.positive_count = 3000
        row.negative_count = 1500

        s = _competitor_topic_sentence(
            db, competitor_id=140, competitor_name="Halloween: The Game",
            competitor_total=10000,
            week_start=date(2026, 8, 24), row=row,
        )
        assert "<strong>Halloween: The Game</strong>" in s
        assert "Halloween Content Posts" in s
        assert "Killer Gameplay" in s
        assert "General Discussion" not in s
        assert "positive momentum" in s
        assert "negative pressure" in s
        assert "neutral" not in s.lower()

    def test_rising_marker_only_when_velocity_high(self):
        trend = [
            _mk_topic("Halloween Content Posts", "positive", velocity=0.15,
                      mention_count=100, trend_direction_str="stable"),
        ]
        db = self._mk_db(trend)
        row = MagicMock()
        row.top_positive_topics = []
        row.top_negative_topics = []
        row.positive_count = 5
        row.negative_count = 1
        s = _competitor_topic_sentence(
            db, 140, "Halloween: The Game",
            competitor_total=1000,
            week_start=date(2026, 8, 24), row=row,
        )
        assert "Halloween Content Posts" in s
        # velocity 0.15 < 1.0 → no rising marker
        assert "(rising)" not in s

    def test_blocks_fringe_topic_by_absolute_floor(self):
        # "Halloween Nights Horror" at 2 mentions must NOT appear even
        # when its velocity is 2.0 (the exact bug Steve flagged).
        trend = [
            _mk_topic("Halloween Nights Horror", "negative", velocity=2.0,
                      mention_count=2, trend_direction_str="rising"),
            _mk_topic("Killer Gameplay", "negative", velocity=0.4,
                      mention_count=200, trend_direction_str="stable"),
        ]
        db = self._mk_db(trend)
        row = MagicMock()
        row.top_positive_topics = []
        row.top_negative_topics = []
        row.positive_count = 3000
        row.negative_count = 1500
        s = _competitor_topic_sentence(
            db, 140, "Halloween: The Game",
            competitor_total=10000,
            week_start=date(2026, 8, 24), row=row,
        )
        assert "Halloween Nights Horror" not in s
        assert "Killer Gameplay" in s

    def test_blocks_fringe_topic_by_relative_floor(self):
        # Topic with 50 mentions is above the absolute floor but only
        # 0.5% of a 10k-post title → blocked.
        trend = [
            _mk_topic("Weekly Reset Complaints", "negative", velocity=1.5,
                      mention_count=50, trend_direction_str="rising"),
            _mk_topic("Killer Gameplay", "negative", velocity=0.5,
                      mention_count=250, trend_direction_str="stable"),
        ]
        db = self._mk_db(trend)
        row = MagicMock()
        row.top_positive_topics = []
        row.top_negative_topics = []
        row.positive_count = 3000
        row.negative_count = 1500
        s = _competitor_topic_sentence(
            db, 140, "Halloween: The Game",
            competitor_total=10000,
            week_start=date(2026, 8, 24), row=row,
        )
        assert "Weekly Reset Complaints" not in s
        assert "Killer Gameplay" in s

    def test_blocklist_beats_all_ranking(self):
        # A topic on the blocklist must be skipped even if it has the
        # highest mention count and velocity.
        trend = [
            _mk_topic("Halloween Nights Horror", "negative", velocity=5.0,
                      mention_count=10000, trend_direction_str="rising"),
            _mk_topic("Killer Gameplay", "negative", velocity=0.4,
                      mention_count=200, trend_direction_str="stable"),
        ]
        db = self._mk_db(trend)
        row = MagicMock()
        row.top_positive_topics = []
        row.top_negative_topics = []
        row.positive_count = 3000
        row.negative_count = 1500
        s = _competitor_topic_sentence(
            db, 140, "Halloween: The Game",
            competitor_total=10000,
            week_start=date(2026, 8, 24), row=row,
        )
        assert "Halloween Nights Horror" not in s
        assert "Killer Gameplay" in s

    def test_no_specific_topic_falls_back_to_stance(self):
        db = self._mk_db([])
        row = MagicMock()
        row.top_positive_topics = ["General Discussion"]
        row.top_negative_topics = ["General Gameplay Talk"]
        row.positive_count = 3
        row.negative_count = 8
        s = _competitor_topic_sentence(
            db, 140, "Halloween: The Game",
            competitor_total=100,
            week_start=date(2026, 8, 24), row=row,
        )
        assert "leans negative" in s
        assert (
            "no specific topic momentum" in s
            or "cleared the reporting floor" in s
        )


class TestCompetitorVolumeBullet:
    def test_bigger_than_parent_uses_fold_notation(self):
        s = _competitor_volume_bullet("Halloween: The Game", 10000, 200)
        assert "<strong>Halloween: The Game</strong>" in s
        assert "10,000" in s
        assert "200" in s
        assert "×" in s or "x" in s.lower()

    def test_on_par(self):
        s = _competitor_volume_bullet("C1", 105, 100)
        assert "on par" in s or "similar" in s

    def test_smaller_than_parent(self):
        s = _competitor_volume_bullet("ILL", 15, 200)
        assert "7%" in s or "below" in s

    def test_zero_competitor(self):
        s = _competitor_volume_bullet("Quiet Peer", 0, 200)
        assert "quiet" in s.lower() or "0" in s

    def test_never_says_neutral(self):
        for a, b in [(10, 100), (100, 100), (1000, 100), (0, 100), (0, 0)]:
            s = _competitor_volume_bullet("X", a, b)
            assert "neutral" not in s.lower()


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

    def test_first_bullet_is_chart_then_per_competitor_pairs(self, monkeypatch):
        # Minimal mock DB: 1 competitor. The build path queries multiple
        # models: CompetitorGame, WindowSummary, TopicTrend, RawPost/
        # SentimentRecord (via the daily series loader). We stub each.
        db = MagicMock()
        cgame = MagicMock()
        cgame.id = 140
        cgame.name = "Halloween: The Game"
        link = MagicMock()
        link.competitor = cgame

        def _query(model):
            q = MagicMock()
            name = getattr(model, "__name__", str(model))
            if name.endswith("CompetitorGame"):
                q.filter_by.return_value.all.return_value = [link]
            elif name.endswith("WindowSummary"):
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
            else:
                # Daily series loader uses func.date() + count queries;
                # return empty group_by().all() so series ends up all zeros.
                q.filter.return_value.group_by.return_value.all.return_value = []
                q.join.return_value.filter.return_value.group_by.return_value.all.return_value = []
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
        assert out is not None and len(out) >= 3
        # First bullet is always the chart
        assert out[0]["kind"] == "chart"
        assert "html" in out[0]
        # Then volume+topic pair(s), one per featured competitor
        volume_bullets = [b for b in out[1:] if b.get("kind") == "volume"]
        topic_bullets = [b for b in out[1:] if b.get("kind") == "topic"]
        assert len(volume_bullets) >= 1
        assert len(topic_bullets) >= 1
        assert "<strong>Halloween: The Game</strong>" in volume_bullets[0]["html"]
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

    def test_renders_img_and_grouped_bullets(self):
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
                    "kind": "volume",
                    "competitor_id": 2, "competitor_name": "C1",
                    "html": "<strong>C1</strong> — 500 posts, 5× the Saber title's 100.",
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
        assert 'alt="Daily post volume, last 28 days' in html_out
        assert '<p ' in html_out and "5× the Saber title" in html_out
        # Both bullets for C1 render inside a SINGLE <li> together
        assert html_out.count("<li") == 1
        assert "500 posts" in html_out and "positive momentum" in html_out

    def test_multiple_competitors_get_separate_li(self):
        b = TitleBlock(
            game_id=1, name="X", total_posts=100,
            positive=50, negative=20, neutral=30,
            pos_neg_ratio="2.5:1",
            executive_summary="", recommended_actions="", bold_ideas=[],
            period_label="", has_data=True,
            competitor_bullets=[
                {"kind": "chart", "chart_data_uri": "",
                 "html": "Peer set generated 500 posts."},
                {"kind": "volume", "competitor_id": 2, "competitor_name": "C1",
                 "html": "<strong>C1</strong> — 200 posts, on par."},
                {"kind": "topic", "competitor_id": 2, "competitor_name": "C1",
                 "html": "<strong>C1</strong> — leans positive."},
                {"kind": "volume", "competitor_id": 3, "competitor_name": "C2",
                 "html": "<strong>C2</strong> — 300 posts, 3×."},
                {"kind": "topic", "competitor_id": 3, "competitor_name": "C2",
                 "html": "<strong>C2</strong> — positive momentum."},
            ],
        )
        html_out = _render_competitive_set(b)
        # Two competitors → two <li>s
        assert html_out.count("<li") == 2

    def test_renders_without_chart_when_uri_empty(self):
        b = TitleBlock(
            game_id=1, name="X", total_posts=100,
            positive=50, negative=20, neutral=30,
            pos_neg_ratio="2.5:1",
            executive_summary="", recommended_actions="", bold_ideas=[],
            period_label="", has_data=True,
            competitor_bullets=[
                {"kind": "chart", "chart_data_uri": "",
                 "html": "Peer set generated 500 posts."},
                {"kind": "volume", "competitor_id": 2, "competitor_name": "C1",
                 "html": "<strong>C1</strong> — 500 posts, 5× the Saber title's 100."},
                {"kind": "topic", "competitor_id": 2, "competitor_name": "C1",
                 "html": "<strong>C1</strong> — leans positive."},
            ],
        )
        html_out = _render_competitive_set(b)
        assert "<img" not in html_out
        assert "Peer set generated 500 posts" in html_out
        assert "<strong>C1</strong>" in html_out

    def test_never_surfaces_neutral(self):
        b = TitleBlock(
            game_id=1, name="X", total_posts=100,
            positive=50, negative=20, neutral=30,
            pos_neg_ratio="2.5:1",
            executive_summary="", recommended_actions="", bold_ideas=[],
            period_label="", has_data=True,
            competitor_bullets=[
                {"kind": "chart", "chart_data_uri": "",
                 "html": "Peer set generated 500 posts."},
                {"kind": "volume", "competitor_id": 2, "competitor_name": "C1",
                 "html": "<strong>C1</strong> — 500 posts, 5× the Saber title's 100."},
                {"kind": "topic", "competitor_id": 2, "competitor_name": "C1",
                 "html": "<strong>C1</strong> — positive momentum on <em>Kills</em>; "
                         "negative pressure on <em>Perks</em>."},
            ],
        )
        assert "neutral" not in _render_competitive_set(b).lower()
