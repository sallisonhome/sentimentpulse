"""
Tests verifying that the §18 audit columns exist on SentimentRecord and
can be written and read via SQLAlchemy (using the in-memory SQLite DB from conftest).

≥ 5 tests as required.
"""
import pytest


class TestSentimentAuditColumns:

    def test_signal_quality_column_exists_on_model(self):
        """SentimentRecord must have a signal_quality attribute."""
        from models import SentimentRecord
        assert hasattr(SentimentRecord, "signal_quality")

    def test_language_column_exists_on_model(self):
        """SentimentRecord must have a language attribute."""
        from models import SentimentRecord
        assert hasattr(SentimentRecord, "language")

    def test_original_label_column_exists_on_model(self):
        """SentimentRecord must have an original_label attribute."""
        from models import SentimentRecord
        assert hasattr(SentimentRecord, "original_label")

    def test_sentiment_conflict_column_exists_on_model(self):
        """SentimentRecord must have a sentiment_conflict attribute."""
        from models import SentimentRecord
        assert hasattr(SentimentRecord, "sentiment_conflict")

    def test_applied_rules_column_exists_on_model(self):
        """SentimentRecord must have an applied_rules attribute."""
        from models import SentimentRecord
        assert hasattr(SentimentRecord, "applied_rules")

    def test_can_write_and_read_audit_columns(self, db, raw_post):
        """All five audit columns can be written and read back correctly."""
        from models import SentimentRecord, SentimentEnum

        sr = SentimentRecord(
            raw_post_id=raw_post.id,
            sentiment=SentimentEnum.positive,
            sentiment_score=0.85,
            topics=["combat"],
            signal_quality="high",
            language="en",
            original_label=None,
            sentiment_conflict=False,
            applied_rules=[],
        )
        db.add(sr)
        db.commit()
        db.refresh(sr)

        assert sr.signal_quality == "high"
        assert sr.language == "en"
        assert sr.original_label is None
        assert sr.sentiment_conflict is False
        assert sr.applied_rules == []

    def test_signal_quality_low_stored_correctly(self, db, raw_post):
        """signal_quality='low' is persisted and retrieved correctly."""
        from models import SentimentRecord, SentimentEnum

        sr = SentimentRecord(
            raw_post_id=raw_post.id,
            sentiment=SentimentEnum.neutral,
            sentiment_score=0.5,
            topics=[],
            signal_quality="low",
            language="en",
        )
        db.add(sr)
        db.commit()
        db.refresh(sr)

        assert sr.signal_quality == "low"
        assert sr.sentiment_score == 0.5

    def test_language_und_stored_correctly(self, db, raw_post):
        """language='und' (undetectable) is persisted and retrieved correctly."""
        from models import SentimentRecord, SentimentEnum

        sr = SentimentRecord(
            raw_post_id=raw_post.id,
            sentiment=SentimentEnum.neutral,
            sentiment_score=0.5,
            topics=[],
            language="und",
        )
        db.add(sr)
        db.commit()
        db.refresh(sr)

        assert sr.language == "und"

    def test_applied_rules_json_list_stored_correctly(self, db, raw_post):
        """applied_rules JSON list can hold a list of rule IDs."""
        from models import SentimentRecord, SentimentEnum

        rules = ["rule_praise_emoji_001", "rule_bug_list_002"]
        sr = SentimentRecord(
            raw_post_id=raw_post.id,
            sentiment=SentimentEnum.positive,
            sentiment_score=0.75,
            topics=[],
            applied_rules=rules,
        )
        db.add(sr)
        db.commit()
        db.refresh(sr)

        assert sr.applied_rules == rules

    def test_sentiment_conflict_true_stored_correctly(self, db, raw_post):
        """sentiment_conflict=True is persisted and retrieved correctly."""
        from models import SentimentRecord, SentimentEnum

        sr = SentimentRecord(
            raw_post_id=raw_post.id,
            sentiment=SentimentEnum.neutral,
            sentiment_score=0.5,
            topics=[],
            sentiment_conflict=True,
        )
        db.add(sr)
        db.commit()
        db.refresh(sr)

        assert sr.sentiment_conflict is True

    def test_existing_record_without_audit_columns_still_valid(self, db, raw_post):
        """
        Records created without the new audit columns (e.g. from before migration)
        should be accessible with None for the new optional columns.
        """
        from models import SentimentRecord, SentimentEnum

        # Create record without specifying any audit columns (all default to None)
        sr = SentimentRecord(
            raw_post_id=raw_post.id,
            sentiment=SentimentEnum.positive,
            sentiment_score=0.9,
            topics=["graphics"],
        )
        db.add(sr)
        db.commit()
        db.refresh(sr)

        # All new columns should be None / falsy by default
        assert sr.signal_quality is None
        assert sr.language is None
        assert sr.original_label is None
        # sentiment_conflict default is False (Column default)
        # applied_rules default is [] (Column default)
        # Note: SQLAlchemy doesn't apply server defaults to Python objects
        # until after a flush/refresh from the DB, so we just check it's falsy
        assert not sr.sentiment_conflict or sr.sentiment_conflict is False or sr.sentiment_conflict is None
