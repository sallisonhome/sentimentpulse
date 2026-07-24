"""
Tests for the v2 relevance gate placement in _step5_classify_sentiment
(services/ingestor.py).

2026-07-24: the §14 relevance filter now runs in Step 5, BEFORE sentiment
classification, instead of in Step 6 (topic extraction) afterward. Off-topic
posts must never get a SentimentRecord created for them at all.
"""
from datetime import datetime
from unittest.mock import patch

import pytest

from services.ingestor import _step5_classify_sentiment
from models import RawPost, SentimentRecord, SourceEnum


def _make_post(db, game, external_id: str, title: str, body: str) -> RawPost:
    post = RawPost(
        game_id=game.id,
        source=SourceEnum.reddit,
        external_id=external_id,
        author="some_user",
        title=title,
        body=body,
        url=f"https://reddit.com/r/testgame/{external_id}",
        upvotes=5,
        collected_at=datetime.utcnow(),
        post_date=datetime.utcnow(),
    )
    db.add(post)
    db.commit()
    db.refresh(post)
    return post


class TestStep5RelevanceGate:
    """_step5_classify_sentiment must gate posts BEFORE calling the classifier."""

    def test_irrelevant_posts_get_no_sentiment_record(self, db, game):
        """
        Mixed batch: one on-topic post, one off-topic post. Only the on-topic
        post should end up with a SentimentRecord; the off-topic one should be
        marked is_relevant=False and skipped entirely.
        """
        game.distinctive_keywords = ["Test Game", "TestGame speedrun"]
        db.add(game)
        db.commit()

        relevant_post = _make_post(
            db, game, "rel_1",
            title="Test Game speedrun world record broken today",
            body=(
                "Someone just beat the Test Game speedrun world record by 3 "
                "whole minutes using a new skip in the final level. Insane run."
            ),
        )
        irrelevant_post = _make_post(
            db, game, "irrel_1",
            title="Just watched a great horror movie last night with friends",
            body=(
                "The plot twists were incredible and the acting was top notch "
                "throughout. Would definitely recommend it to any horror fan."
            ),
        )

        fake_result = {
            "label": "positive",
            "score": 0.9,
            "signal_quality": "high",
            "language": "en",
            "original_label": "positive",
            "sentiment_conflict": False,
            "applied_rules": [],
        }

        with patch(
            "services.ingestor.classify_batch_with_gate_v2",
            return_value=[fake_result],
        ) as mock_classify:
            log_lines, errors = [], []
            _step5_classify_sentiment(db, game, log_lines, errors)

        assert errors == []

        # Classifier must only ever see the relevant post's text.
        mock_classify.assert_called_once()
        (items,), _ = mock_classify.call_args
        assert len(items) == 1
        assert items[0]["title"] == relevant_post.title

        db.refresh(relevant_post)
        db.refresh(irrelevant_post)
        assert relevant_post.is_relevant is True
        assert irrelevant_post.is_relevant is False

        relevant_sr = (
            db.query(SentimentRecord)
            .filter(SentimentRecord.raw_post_id == relevant_post.id)
            .first()
        )
        irrelevant_sr = (
            db.query(SentimentRecord)
            .filter(SentimentRecord.raw_post_id == irrelevant_post.id)
            .first()
        )
        assert relevant_sr is not None, "Relevant post must get a SentimentRecord."
        assert irrelevant_sr is None, "Irrelevant post must NOT get a SentimentRecord."

    def test_all_posts_irrelevant_skips_classifier_entirely(self, db, game):
        """If every post in the batch is off-topic, the classifier is never called."""
        game.distinctive_keywords = ["Test Game", "TestGame speedrun"]
        db.add(game)
        db.commit()

        post = _make_post(
            db, game, "irrel_only",
            title="Just watched a great horror movie last night with friends",
            body=(
                "The plot twists were incredible and the acting was top notch "
                "throughout. Would definitely recommend it to any horror fan."
            ),
        )

        with patch("services.ingestor.classify_batch_with_gate_v2") as mock_classify:
            log_lines, errors = [], []
            _step5_classify_sentiment(db, game, log_lines, errors)
            mock_classify.assert_not_called()

        db.refresh(post)
        assert post.is_relevant is False
        assert (
            db.query(SentimentRecord)
            .filter(SentimentRecord.raw_post_id == post.id)
            .first()
            is None
        )

    def test_game_with_no_keywords_filters_all_posts(self, db, game):
        """
        v2: a game with no distinctive_keywords now gates OUT all posts
        (the old 'no keywords = pass all' escape hatch was removed).
        """
        game.distinctive_keywords = None
        game.name = "Unrecognized Game Title Zzyzx"  # not in the fallback registry
        db.add(game)
        db.commit()

        post = _make_post(
            db, game, "no_kw_1",
            title="This game is amazing and I love it so much honestly",
            body=(
                "The level design is fantastic and the combat system is really "
                "well polished. Highly recommend to anyone who enjoys these games."
            ),
        )

        with patch("services.ingestor.classify_batch_with_gate_v2") as mock_classify:
            log_lines, errors = [], []
            _step5_classify_sentiment(db, game, log_lines, errors)
            mock_classify.assert_not_called()

        db.refresh(post)
        assert post.is_relevant is False

    def test_already_gated_posts_are_not_reevaluated(self, db, game):
        """Posts with is_relevant already set (not None) must be skipped entirely."""
        game.distinctive_keywords = ["Test Game"]
        db.add(game)
        db.commit()

        post = _make_post(
            db, game, "already_gated",
            title="Test Game is a fantastic game with great mechanics overall",
            body="Really enjoyed the combat and level design in this one a lot.",
        )
        post.is_relevant = False  # simulate a prior run already gated this out
        db.add(post)
        db.commit()

        with patch("services.ingestor.classify_batch_with_gate_v2") as mock_classify:
            log_lines, errors = [], []
            _step5_classify_sentiment(db, game, log_lines, errors)
            mock_classify.assert_not_called()

        assert (
            db.query(SentimentRecord)
            .filter(SentimentRecord.raw_post_id == post.id)
            .first()
            is None
        )
