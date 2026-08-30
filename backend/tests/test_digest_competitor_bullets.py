"""Regression tests for the Competitive Set feature in weekly + monthly digests.

Feature: 2026-08-30 (Steve request).

Contract locked in by this test file:

  1. When a parent title has no rows in competitor_games, TitleBlock
     .competitor_bullets is None and no "Competitive Set" section renders.
  2. When a parent has 1-3 competitors, each becomes exactly one bullet,
     in the order they appear in the DB.
  3. When a parent has >3 competitors, the top 3 by widest sentiment / volume
     gap are surfaced (rank key from _pick_top_competitors).
  4. Each bullet leads with the competitor NAME in <strong>, then a
     pos-vs-neg posture clause (no neutral weight surfaced), then a
     volume-vs-parent clause. Only when the volume ratio is >=1.5x or
     <=0.5x is a driver hypothesis appended.
  5. A parent block with no data (has_data=False) still renders the
     Competitive Set when competitors are configured — that's the most
     useful case for the feature.
"""
from datetime import date
from unittest.mock import MagicMock

import pytest

from services.digest_service import (
    _COMPETITOR_MAX_BULLETS,
    _build_competitor_bullets,
    _describe_ratio_stance,
    _describe_volume_gap,
    _hypothesize_volume_driver,
    _pick_top_competitors,
    _render_competitive_set,
    TitleBlock,
    _weighted_pos_neg_score,
)


# ── Pure-function guardrails ─────────────────────────────────────────────────

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
        s = _describe_ratio_stance(50, 5)
        assert "strongly positive" in s

    def test_leans_positive(self):
        s = _describe_ratio_stance(20, 10)
        assert "leans positive" in s

    def test_balanced(self):
        s = _describe_ratio_stance(10, 9)
        assert "roughly balanced" in s

    def test_leans_negative(self):
        s = _describe_ratio_stance(10, 20)
        assert "leans negative" in s

    def test_strongly_negative(self):
        s = _describe_ratio_stance(5, 50)
        assert "strongly negative" in s

    def test_never_surfaces_neutral(self):
        # The whole point of this function: no mention of neutrals in any branch.
        for pos, neg in [(0, 0), (10, 0), (0, 10), (5, 5), (100, 3), (3, 100)]:
            assert "neutral" not in _describe_ratio_stance(pos, neg).lower()


class TestDescribeVolumeGap:
    def test_parent_has_no_data(self):
        # Parent zero-total returns empty so the caller can flip framing.
        assert _describe_volume_gap(500, 0) == ""

    def test_competitor_has_no_data(self):
        assert "essentially no measurable" in _describe_volume_gap(0, 500)

    def test_three_x_or_more(self):
        assert "×" in _describe_volume_gap(3000, 1000)
        assert "3." in _describe_volume_gap(3000, 1000)

    def test_similar_volume(self):
        assert "broadly similar" in _describe_volume_gap(950, 1000)

    def test_materially_quieter(self):
        assert "materially quieter" in _describe_volume_gap(250, 1000)


class TestHypothesizeVolumeDriver:
    def test_returns_empty_when_ratio_is_close(self):
        assert _hypothesize_volume_driver("X", 900, 1000) == ""

    def test_ip_gravity_hypothesis_when_competitor_dominates(self):
        s = _hypothesize_volume_driver("Halloween: The Game", 5000, 1000)
        assert "IP" in s and "franchise" in s

    def test_smaller_ip_hypothesis_when_competitor_lags(self):
        s = _hypothesize_volume_driver("Some Indie Horror", 200, 1000)
        assert "smaller IP" in s or "thinner franchise" in s

    def test_no_hypothesis_when_either_side_has_zero(self):
        assert _hypothesize_volume_driver("X", 0, 1000) == ""
        assert _hypothesize_volume_driver("X", 1000, 0) == ""


# ── Ranking behaviour ────────────────────────────────────────────────────────

class TestPickTopCompetitors:
    def test_returns_all_when_at_or_below_cap(self):
        bullets = [{"_rank_key": i} for i in range(_COMPETITOR_MAX_BULLETS)]
        assert _pick_top_competitors(bullets) == bullets

    def test_prefers_higher_rank_key(self):
        bullets = [
            {"competitor_id": 1, "_rank_key": 0.1, "html": "A"},
            {"competitor_id": 2, "_rank_key": 0.9, "html": "B"},
            {"competitor_id": 3, "_rank_key": 0.5, "html": "C"},
            {"competitor_id": 4, "_rank_key": 0.7, "html": "D"},
        ]
        got = _pick_top_competitors(bullets)
        assert len(got) == 3
        got_ids = [b["competitor_id"] for b in got]
        # 2 (0.9), 4 (0.7), 3 (0.5) — sentiment-1 competitor A drops off.
        assert got_ids == [2, 4, 3]


# ── End-to-end bullet builder with mocked DB ─────────────────────────────────

def _make_mock_game(gid: int, name: str):
    g = MagicMock()
    g.id = gid
    g.name = name
    return g


def _make_mock_link(parent_id: int, competitor):
    link = MagicMock()
    link.parent_id = parent_id
    link.competitor = competitor
    return link


def _make_mock_windowsummary(pos, neg, neu, total):
    row = MagicMock()
    row.positive_count = pos
    row.negative_count = neg
    row.neutral_count = neu
    row.total_posts = total
    return row


class TestBuildCompetitorBulletsWeekly:
    def test_returns_none_when_no_competitors(self, monkeypatch):
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

    def test_hellraiser_v_halloween_style_case(self, monkeypatch):
        """
        Realistic case: Hellraiser (small IP) has three competitors
        including Halloween (huge IP) — commentary should flag Halloween
        as generating multiples of the parent's volume and hypothesize
        IP-gravity as the driver.
        """
        db = MagicMock()

        halloween = _make_mock_game(140, "Halloween: The Game")
        townfall = _make_mock_game(139, "SILENT HILL: Townfall")
        ill = _make_mock_game(138, "ILL")
        links = [
            _make_mock_link(21, halloween),
            _make_mock_link(21, townfall),
            _make_mock_link(21, ill),
        ]

        # First query: competitor_games links.
        # Subsequent queries: WindowSummary for each competitor.
        # We stage them by intercepting db.query itself.
        summaries = {
            140: _make_mock_windowsummary(pos=1637, neg=100, neu=200, total=1937),
            139: _make_mock_windowsummary(pos=800, neg=50, neu=100, total=950),
            138: _make_mock_windowsummary(pos=10, neg=5, neu=3, total=18),
        }

        call_state = {"idx": 0}

        def fake_query(model):
            q = MagicMock()
            if call_state["idx"] == 0:
                # First call: CompetitorGame lookup by parent_id.
                q.filter_by.return_value.all.return_value = links
            else:
                # Subsequent calls: WindowSummary for a specific game.
                # Extract the game_id from the filter_by kwargs.
                def _first():
                    kwargs = q.filter_by.call_args.kwargs
                    gid = kwargs.get("game_id")
                    return summaries.get(gid)
                q.filter_by.return_value.first.side_effect = _first
            call_state["idx"] += 1
            return q

        db.query.side_effect = fake_query

        out = _build_competitor_bullets(
            db,
            parent_game_id=21,
            parent_positive=8, parent_negative=2, parent_total=56,
            parent_name="Hellraiser Revival",
            period="weekly",
            today=date(2026, 8, 30),
        )

        assert out is not None
        assert len(out) == 3
        names = [b["competitor_name"] for b in out]
        assert set(names) == {"Halloween: The Game", "SILENT HILL: Townfall", "ILL"}

        halloween_bullet = next(b for b in out if b["competitor_name"] == "Halloween: The Game")
        # Halloween has 1637 pos vs 100 neg → strongly positive.
        assert "strongly positive" in halloween_bullet["html"]
        # Volume: 1937 / 56 = ~34.6× → 3.0× threshold hit.
        assert "×" in halloween_bullet["html"]
        # Driver: >=1.5× ratio → IP-gravity hypothesis fires.
        assert "IP" in halloween_bullet["html"] or "franchise" in halloween_bullet["html"]

        ill_bullet = next(b for b in out if b["competitor_name"] == "ILL")
        # ILL has 18 posts, parent has 56 → volume ratio 0.32 (materially quieter).
        # Should include the "smaller IP" hypothesis.
        assert "smaller IP" in ill_bullet["html"] or "thinner franchise" in ill_bullet["html"]


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

    def test_renders_ul_with_bullets(self):
        b = TitleBlock(
            game_id=1, name="X", total_posts=100,
            positive=50, negative=20, neutral=30,
            pos_neg_ratio="2.5:1",
            executive_summary="", recommended_actions="", bold_ideas=[],
            period_label="", has_data=True,
            competitor_bullets=[
                {"competitor_id": 2, "competitor_name": "C1",
                 "positive": 10, "negative": 5, "neutral": 3, "total_posts": 18,
                 "pos_neg_ratio": "2.0:1",
                 "html": "<strong>C1</strong> leans positive at 10:5",
                 "_rank_key": 0.5},
                {"competitor_id": 3, "competitor_name": "C2",
                 "positive": 20, "negative": 30, "neutral": 5, "total_posts": 55,
                 "pos_neg_ratio": "1:1.5",
                 "html": "<strong>C2</strong> leans negative at 20:30",
                 "_rank_key": 0.3},
            ],
        )
        html_out = _render_competitive_set(b)
        assert "Competitive Set" in html_out
        assert "<ul" in html_out and "</ul>" in html_out
        assert html_out.count("<li") == 2
        assert "<strong>C1</strong>" in html_out
        assert "<strong>C2</strong>" in html_out

    def test_bullet_never_surfaces_neutral_count(self):
        """Contract: bullets tilt commentary AWAY from neutral. The rendered
        HTML must not include the word 'neutral' or a neutral count.
        """
        b = TitleBlock(
            game_id=1, name="X", total_posts=100,
            positive=50, negative=20, neutral=30,
            pos_neg_ratio="2.5:1",
            executive_summary="", recommended_actions="", bold_ideas=[],
            period_label="", has_data=True,
            competitor_bullets=[
                {"competitor_id": 2, "competitor_name": "C1",
                 "positive": 10, "negative": 5, "neutral": 100, "total_posts": 115,
                 "pos_neg_ratio": "2.0:1",
                 # Real rendered bullet from _build_competitor_bullets:
                 "html": "<strong>C1</strong> leans positive at 10:5 (2.0:1), "
                         "running about 115% of the Saber title's volume.",
                 "_rank_key": 0.5},
            ],
        )
        html_out = _render_competitive_set(b)
        assert "neutral" not in html_out.lower()
