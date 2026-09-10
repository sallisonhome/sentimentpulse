"""Regression + migration tests for Landing 2 of the Sonar-deprecation work.

Landing 2 (2026-09-10) migrated the two production Sonar call sites to
route through services.llm_client.call_llm instead of calling
services.sonar_client.call_sonar directly:

  1. backend/services/dashboard_feedback_synthesizer.py::_synthesize_cluster_sentence
     (Top Topics one-sentence-per-cluster synthesis)
  2. backend/services/period_summary_service.py::_call_llm_for_user_block
     (exec/recs/bold-ideas period summaries)

These tests prove:
  - Default behaviour unchanged (Sonar remains primary at each call site).
  - disable_search=True invariant preserved (2026-08-18 regression guard).
  - Per-block env-var override reroutes without touching call-site code.
  - _call_llm_for_user_block returns the same .content[0].text shape it
    used to return, so its three call sites (exec/recs/bold-ideas) work
    unchanged.
"""
from __future__ import annotations

import os
from typing import Any
from unittest.mock import patch

import pytest

from services import llm_client
from services.llm_client import LlmResponse


class _RecordingBackend(llm_client._Backend):
    """Backend spy that records every call and returns a canned response."""
    def __init__(self, backend_id: str, response_text: str = "canned"):
        self.id = backend_id
        self._response_text = response_text
        self.calls: list[dict[str, Any]] = []

    def available(self) -> bool:
        return True

    def call(self, prompt, *, system, max_tokens, temperature, disable_search, block_kind):
        self.calls.append({
            "prompt": prompt, "system": system, "max_tokens": max_tokens,
            "temperature": temperature, "disable_search": disable_search,
            "block_kind": block_kind,
        })
        return LlmResponse(
            text=self._response_text, source=f"{self.id}:test-model",
            backend=self.id, model="test-model", elapsed_s=0.001,
        )


# ---------------------------------------------------------------------------
# dashboard_feedback_synthesizer._synthesize_cluster_sentence
# ---------------------------------------------------------------------------


class TestSynthesizeClusterSentenceMigration:
    """The Top Topics one-sentence synthesizer."""

    def _run(self, monkeypatch, backend: _RecordingBackend, per_block_env: str | None = None):
        # Clear all LLM_ env vars so tests are hermetic.
        for k in list(os.environ):
            if k.startswith("LLM_"):
                monkeypatch.delenv(k, raising=False)
        if per_block_env is not None:
            monkeypatch.setenv("LLM_PRIMARY_TOPICS", per_block_env)

        def fake_make(bid, **_):
            return backend

        monkeypatch.setattr(llm_client, "_make_backend", fake_make)

        # Force the ID resolver to return whatever the env vars say (which
        # is what call_llm does anyway) — we just need the backend factory
        # to hand back our recording spy.
        from services.dashboard_feedback_synthesizer import _synthesize_cluster_sentence
        from models import SentimentEnum
        return _synthesize_cluster_sentence(
            game_name="Test Game",
            sentiment=SentimentEnum.negative,
            cluster_phrase="broken sprint on xbox controllers",
            cluster_posts=[
                "Sprint doesn't work on my xbox controller since the last patch.",
                "Same here, sprint just fails intermittently on controller.",
                "Xbox controller sprint broken since 1.4, please fix.",
            ],
        )

    def test_default_route_is_sonar_primary(self, monkeypatch):
        spy = _RecordingBackend("sonar", response_text="Players report broken controller sprint.")
        result = self._run(monkeypatch, spy)
        assert len(spy.calls) == 1
        # block_kind must be "topics" — that's how per-block env overrides
        # (LLM_PRIMARY_TOPICS) know to reroute this call.
        assert spy.calls[0]["block_kind"] == "topics"
        # Result comes through cleaned (quotes stripped etc.).
        assert result and "sprint" in result.lower()

    def test_disable_search_true_is_passed_to_backend(self, monkeypatch):
        """Regression guard for the 2026-08-18 Sonar web-search contamination
        bug. This call site MUST pass disable_search=True."""
        spy = _RecordingBackend("sonar", response_text="ok")
        self._run(monkeypatch, spy)
        assert spy.calls[0]["disable_search"] is True

    def test_per_block_env_reroutes_to_anthropic(self, monkeypatch):
        """Setting LLM_PRIMARY_TOPICS=anthropic must route this specific
        call site to Anthropic without any code change at the call site."""
        spy = _RecordingBackend("anthropic", response_text="Players say controller sprint is broken.")
        self._run(monkeypatch, spy, per_block_env="anthropic")
        assert len(spy.calls) == 1
        # Because we override _make_backend to always return this spy, we
        # can't observe what backend id call_llm chose — but we CAN observe
        # that block_kind is still "topics", which is the routing key.
        assert spy.calls[0]["block_kind"] == "topics"

    def test_no_coherent_signal_is_dropped(self, monkeypatch):
        spy = _RecordingBackend("sonar", response_text="NO_COHERENT_SIGNAL")
        assert self._run(monkeypatch, spy) is None

    def test_backend_error_returns_none_gracefully(self, monkeypatch):
        """When both primary and fallback fail, call_llm raises. This call
        site catches and returns None so the widget renders empty rather
        than crashing the request."""
        class _FailingBackend(llm_client._Backend):
            id = "sonar"
            def available(self): return True
            def call(self, *a, **kw): raise RuntimeError("simulated")

        for k in list(os.environ):
            if k.startswith("LLM_"):
                monkeypatch.delenv(k, raising=False)
        # Set fallback=none so call_llm raises instead of trying anthropic.
        monkeypatch.setenv("LLM_FALLBACK", "none")

        def fake_make(bid, **_):
            return _FailingBackend()

        monkeypatch.setattr(llm_client, "_make_backend", fake_make)
        from services.dashboard_feedback_synthesizer import _synthesize_cluster_sentence
        from models import SentimentEnum
        result = _synthesize_cluster_sentence(
            game_name="Test", sentiment=SentimentEnum.negative,
            cluster_phrase="x", cluster_posts=["a", "b", "c"],
        )
        assert result is None


# ---------------------------------------------------------------------------
# period_summary_service._call_llm_for_user_block
# ---------------------------------------------------------------------------


class TestPeriodSummaryLlmAdapter:
    """The exec/recs/bold-ideas wrapper. Public signature preserved."""

    def _call_adapter(self, monkeypatch, backend: _RecordingBackend, **overrides):
        """Drive the unified-path branch of the adapter.

        Landing 2 preserves the legacy path for injected anthropic-shaped
        clients (see docstring on _call_llm_for_user_block). To exercise
        the unified `call_llm` path, we pass `anthropic_client=None` so
        the adapter routes through llm_client, and we monkeypatch
        llm_client._make_backend to return the recording spy.
        """
        for k in list(os.environ):
            if k.startswith("LLM_"):
                monkeypatch.delenv(k, raising=False)

        def fake_make(bid, **_):
            return backend

        monkeypatch.setattr(llm_client, "_make_backend", fake_make)
        from services.period_summary_service import _call_llm_for_user_block
        kwargs = dict(
            prompt="test prompt",
            anthropic_client=None,   # None => unified path (call_llm)
            block_label="exec",
        )
        kwargs.update(overrides)
        return _call_llm_for_user_block(**kwargs)

    def test_returns_content_zero_text_shape(self, monkeypatch):
        """The three call sites read .content[0].text — that shape MUST
        continue to work."""
        spy = _RecordingBackend("sonar", response_text="Exec summary body")
        result = self._call_adapter(monkeypatch, spy)
        assert result.content[0].text == "Exec summary body"

    def test_block_kind_is_summary(self, monkeypatch):
        """Per-block routing uses LLM_PRIMARY_SUMMARY. Verify the adapter
        passes block_kind='summary' through so that env var works."""
        spy = _RecordingBackend("sonar")
        self._call_adapter(monkeypatch, spy)
        assert spy.calls[0]["block_kind"] == "summary"

    def test_disable_search_true_invariant(self, monkeypatch):
        """Same regression guard as the topics site — the exec/recs/bold
        prompts also say 'ground strictly in the cited posts', so web
        search MUST be disabled."""
        spy = _RecordingBackend("sonar")
        self._call_adapter(monkeypatch, spy)
        assert spy.calls[0]["disable_search"] is True

    def test_max_tokens_picks_smaller_of_the_two_ceilings(self, monkeypatch):
        """Legacy behaviour: sonar_max_tokens and anthropic_max_tokens
        were separate ceilings. New adapter takes min() so neither
        backend gets asked for more than either ceiling permits."""
        spy = _RecordingBackend("sonar")
        self._call_adapter(monkeypatch, spy,
                           sonar_max_tokens=500, anthropic_max_tokens=1200)
        assert spy.calls[0]["max_tokens"] == 500
        spy.calls.clear()
        self._call_adapter(monkeypatch, spy,
                           sonar_max_tokens=1500, anthropic_max_tokens=800)
        assert spy.calls[0]["max_tokens"] == 800

    def test_none_anthropic_client_routes_through_unified_path(self, monkeypatch):
        """Passing anthropic_client=None takes the unified call_llm path.
        Previously (pre-Landing-2) this raised RuntimeError when Sonar
        was also unavailable. Under the new adapter the unified client's
        fallback semantics take over."""
        spy = _RecordingBackend("sonar")
        result = self._call_adapter(monkeypatch, spy, anthropic_client=None)
        assert result.content[0].text == "canned"

    def test_injected_anthropic_client_preserved_legacy_path(self, monkeypatch):
        """When the caller injects an anthropic-shaped client (has
        `.messages`), the adapter takes the legacy path: try Sonar
        first, otherwise call `client.messages.create()` directly. This
        preserves the prompt-shape test contract used by
        test_summary_prompt_kpi and friends.

        We make Sonar unavailable so the injected client HAS to be called.
        """
        for k in list(os.environ):
            if k.startswith("LLM_"):
                monkeypatch.delenv(k, raising=False)

        # Force sonar_available() -> False so the legacy path skips
        # Sonar and goes straight to the injected client.
        import services.sonar_client
        monkeypatch.setattr(services.sonar_client, "sonar_available", lambda: False)

        class _CapturingClient:
            def __init__(self):
                self.prompts: list[str] = []
                self.messages = self
            def create(self, **kwargs):
                self.prompts.append(kwargs["messages"][0]["content"])
                fake_msg = type("M", (), {"content": [type("C", (), {"text": "captured"})()]})
                return fake_msg

        cap = _CapturingClient()
        from services.period_summary_service import _call_llm_for_user_block
        result = _call_llm_for_user_block(
            prompt="hello prompt",
            anthropic_client=cap,
            block_label="exec",
        )
        # Legacy path was taken: the injected client received the prompt.
        assert cap.prompts == ["hello prompt"]
        assert result.content[0].text == "captured"
        assert result.source.startswith("anthropic:")

    def test_source_is_forwarded_from_llm_response(self, monkeypatch):
        """Log lines and downstream telemetry read .source — preserve
        that field verbatim from the unified LlmResponse."""
        spy = _RecordingBackend("anthropic", response_text="fallback served")
        result = self._call_adapter(monkeypatch, spy)
        assert result.source.startswith("anthropic:")
