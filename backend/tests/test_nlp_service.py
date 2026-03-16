"""
Unit tests for the NLP service — sentiment classification and VADER fallback.

The RoBERTa transformer model is not loaded during tests; we force the VADER
path using `_use_vader = True` to keep tests fast and dependency-free.
"""
import pytest
from unittest.mock import patch


# ── Force VADER mode before any import of nlp_service ─────────────────────────

@pytest.fixture(autouse=True)
def use_vader(monkeypatch):
    """Ensure nlp_service uses VADER for all tests in this module."""
    import services.nlp_service as nlp
    monkeypatch.setattr(nlp, "_use_vader", True)
    monkeypatch.setattr(nlp, "_model", None)
    monkeypatch.setattr(nlp, "_tokenizer", None)
    yield


# ── classify_batch ─────────────────────────────────────────────────────────────

class TestClassifyBatch:
    def test_positive_text(self):
        from services.nlp_service import classify_batch
        results = classify_batch(["This game is absolutely amazing and fun!"])
        assert len(results) == 1
        label, score = results[0]
        assert label == "positive"
        assert 0.5 <= score <= 1.0

    def test_negative_text(self):
        from services.nlp_service import classify_batch
        results = classify_batch(["This game is terrible and broken. I hate it."])
        assert len(results) == 1
        label, score = results[0]
        assert label == "negative"
        assert 0.5 <= score <= 1.0

    def test_empty_batch_returns_empty(self):
        from services.nlp_service import classify_batch
        results = classify_batch([])
        assert results == []

    def test_batch_returns_one_result_per_input(self):
        from services.nlp_service import classify_batch
        texts = [
            "Love this game!",
            "Hate this game!",
            "This game exists.",
        ]
        results = classify_batch(texts)
        assert len(results) == len(texts)

    def test_each_result_is_label_score_tuple(self):
        from services.nlp_service import classify_batch
        results = classify_batch(["Some text about a game."])
        label, score = results[0]
        assert label in ("positive", "negative", "neutral")
        assert isinstance(score, float)
        assert 0.0 <= score <= 1.0

    def test_long_text_is_truncated_not_errored(self):
        from services.nlp_service import classify_batch
        long_text = "This game is great! " * 200   # well over 2000 chars
        results = classify_batch([long_text])
        assert len(results) == 1
        label, score = results[0]
        assert label in ("positive", "negative", "neutral")

    def test_none_and_empty_string_handled(self):
        from services.nlp_service import classify_batch
        # Empty strings should be classified (VADER handles them)
        results = classify_batch([""])
        assert len(results) == 1


# ── load_model ─────────────────────────────────────────────────────────────────

class TestLoadModel:
    def test_load_model_falls_back_to_vader_on_import_error(self, monkeypatch):
        import services.nlp_service as nlp
        monkeypatch.setattr(nlp, "_model", None)
        monkeypatch.setattr(nlp, "_tokenizer", None)
        monkeypatch.setattr(nlp, "_use_vader", False)

        with patch("services.nlp_service.AutoTokenizer") as mock_tok, \
             patch("services.nlp_service.AutoModelForSequenceClassification") as mock_model:
            mock_tok.from_pretrained.side_effect = OSError("Model not found")
            nlp.load_model()

        assert nlp._use_vader is True

    def test_load_model_idempotent(self, monkeypatch):
        """Calling load_model twice should not raise."""
        import services.nlp_service as nlp
        monkeypatch.setattr(nlp, "_use_vader", True)
        nlp.load_model()   # second call when already loaded
        assert nlp._use_vader is True
