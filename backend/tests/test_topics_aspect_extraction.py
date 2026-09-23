"""2026-09-23 — Top Topics grounded aspect extraction.

The old phrase clusterer labelled clusters with the most frequent content
word ("About", "Far", "New", "Myers"), the LLM rejected those incoherent
clusters, and 42 of 43 live titles rendered an empty card. These tests pin
the replacement contract: concrete aspect labels, >= 3 validated citations,
transient failures are never cached, and filter survivors lead the corpus.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from models import SentimentEnum
from services import dashboard_feedback_synthesizer as m


def _resp(topics):
    return SimpleNamespace(text=json.dumps({"topics": topics}))


class TestParseAspectResponse:
    def test_keeps_grounded_topic(self):
        out = m._parse_aspect_response(
            json.dumps({"topics": [{"label": "PC Performance",
                                    "detail": "Stutters and crashes disrupt play.",
                                    "posts": [1, 2, 3, 4]}]}),
            n_sample=10,
        )
        assert out == [{"label": "PC Performance",
                        "detail": "Stutters and crashes disrupt play.",
                        "cited": [1, 2, 3, 4]}]

    def test_drops_topic_with_fewer_than_three_citations(self):
        out = m._parse_aspect_response(
            json.dumps({"topics": [{"label": "Menus", "detail": "x.", "posts": [1, 2]}]}),
            n_sample=10,
        )
        assert out == []

    def test_out_of_range_and_duplicate_citations_do_not_count(self):
        out = m._parse_aspect_response(
            json.dumps({"topics": [{"label": "Menus", "detail": "x.",
                                    "posts": [1, 1, 99, 0, "P2"]}]}),
            n_sample=10,
        )
        assert out == []  # only P1 and P2 are real

    @pytest.mark.parametrize("label", ["General Discussion", "Purchase Intent",
                                       "Hype", "Gameplay", "Other"])
    def test_rejects_non_aspect_labels(self, label):
        out = m._parse_aspect_response(
            json.dumps({"topics": [{"label": label, "detail": "x.", "posts": [1, 2, 3]}]}),
            n_sample=10,
        )
        assert out == []

    def test_rejects_long_labels(self):
        out = m._parse_aspect_response(
            json.dumps({"topics": [{"label": "The way the melee combat feels here",
                                    "detail": "x.", "posts": [1, 2, 3]}]}),
            n_sample=10,
        )
        assert out == []

    def test_sorted_by_citations_and_capped_at_two(self):
        topics = [
            {"label": "A Aspect", "detail": "a.", "posts": [1, 2, 3]},
            {"label": "B Aspect", "detail": "b.", "posts": [1, 2, 3, 4, 5]},
            {"label": "C Aspect", "detail": "c.", "posts": [1, 2, 3, 4]},
        ]
        out = m._parse_aspect_response(json.dumps({"topics": topics}), n_sample=10)
        assert [t["label"] for t in out] == ["B Aspect", "C Aspect"]

    def test_tolerates_prose_around_json(self):
        text = 'Here you go:\n{"topics": [{"label": "Stealth", "detail": "x.", "posts": [1,2,3]}]}\nDone.'
        assert m._parse_aspect_response(text, n_sample=5)[0]["label"] == "Stealth"

    def test_raises_on_non_json(self):
        with pytest.raises(ValueError):
            m._parse_aspect_response("NO_COHERENT_SIGNAL", n_sample=5)


class TestSelectExtractionCorpus:
    def test_filter_survivors_lead_then_substantive_extras(self):
        strong = "The melee combat is great and the boss fights feel heavy"
        extra = "I played a few hours last night with some friends online today"
        short = "ok"
        with patch.object(m, "_has_opinion_and_specificity",
                          side_effect=lambda x: x == strong):
            sample, pool = m._select_extraction_corpus([extra, short, strong])
        assert [t for _i, t in sample] == [strong, extra]
        assert pool == 2  # short post excluded from the pool

    def test_sample_capped(self):
        texts = [f"post number {i} talks about the melee combat feel a lot" for i in range(500)]
        sample, pool = m._select_extraction_corpus(texts)
        assert len(sample) == m._EXTRACT_SAMPLE_MAX
        assert pool == 500


class TestExtractAspectTopics:
    def test_volume_scaled_to_pool(self):
        texts = [f"post {i} says the co-op matchmaking is broken again" for i in range(160)]
        cited = list(range(1, 21))  # 20 of 80 sampled
        with patch("services.llm_client.call_llm",
                   return_value=_resp([{"label": "Co-op Matchmaking",
                                        "detail": "Lobbies fail to fill.",
                                        "posts": cited}])):
            out = m._extract_aspect_topics("G", SentimentEnum.negative, texts)
        assert out[0].label == "Co-op Matchmaking"
        assert out[0].volume == 40  # 20 cited × (160 pool / 80 sample)

    def test_llm_exception_returns_none(self):
        texts = ["the melee combat is great and weighty in every fight"] * 5
        with patch("services.llm_client.call_llm", side_effect=RuntimeError("boom")):
            assert m._extract_aspect_topics("G", SentimentEnum.positive, texts) is None

    def test_prompt_disables_search(self):
        texts = ["the melee combat is great and weighty in every fight"] * 5
        with patch("services.llm_client.call_llm", return_value=_resp([])) as call:
            m._extract_aspect_topics("G", SentimentEnum.positive, texts)
        assert call.call_args.kwargs["disable_search"] is True
        assert call.call_args.kwargs["block_kind"] == "topics"


class TestTransientFailureNotCached:
    def test_failed_extraction_is_retried_next_call(self, db):
        from models import Game, Publisher, RawPost, SentimentRecord, SourceEnum

        m._CACHE.clear()
        pub = Publisher(name="Retry Pub"); db.add(pub); db.flush()
        g = Game(publisher_id=pub.id, steam_app_id=99123, name="RetryGame", is_active=True)
        db.add(g); db.flush()
        for i in range(5):
            rp = RawPost(game_id=g.id, source=SourceEnum.steam_review,
                         external_id=f"retry_{i}",
                         body="The melee combat is great and every hit feels weighty",
                         is_relevant=True,
                         post_date=datetime.now(timezone.utc) - timedelta(hours=i),
                         collected_at=datetime.now(timezone.utc))
            db.add(rp); db.flush()
            db.add(SentimentRecord(raw_post_id=rp.id, sentiment=SentimentEnum.positive,
                                   sentiment_score=0.8, topics=[]))
        db.commit()

        kwargs = dict(db=db, game_id=g.id, game_name=g.name,
                      sentiment=SentimentEnum.positive, period_key="weekly",
                      period_start=date.today() - timedelta(days=7))
        with patch.object(m, "_extract_aspect_topics", return_value=None):
            assert m.generate_feedback_summary(**kwargs) == []
        assert m._cache_get((g.id, "weekly", "positive")) is None

        good = [m.TopicSummaryOut(label="Melee Combat", detail="Hits feel weighty.", volume=5)]
        with patch.object(m, "_extract_aspect_topics", return_value=good):
            out = m.generate_feedback_summary(**kwargs)
        assert out and out[0].label == "Melee Combat"
