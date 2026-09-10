"""Unit tests for the unified LLM client (Landing 1 of the Sonar-deprecation
migration, 2026-09-10).

Scope: routing, fallback semantics, env-var precedence, backend factory
correctness, response parsing for each backend, disable_search default
preservation (regression guard for the 2026-08-18 Sonar web-search
contamination lesson).

Non-scope: live HTTP calls to Sonar / Anthropic / Agent API. Every
network path is mocked. The live diagnostic endpoint is a separate
verification path.
"""
from __future__ import annotations

import io
import json
import os
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from services import llm_client
from services.llm_client import (
    _AGENT_API_URL,
    _ANTHROPIC_DEFAULT_MODEL,
    _AgentApiBackend,
    _AnthropicBackend,
    _SONAR_TO_AGENT_PRESET,
    _SonarBackend,
    _make_backend,
    _resolve_backend_id,
    _resolve_fallback_id,
    LlmResponse,
    call_llm,
    describe_routing,
)


# ---------------------------------------------------------------------------
# _make_backend factory
# ---------------------------------------------------------------------------


class TestBackendFactory:
    def test_factory_returns_sonar_backend_for_sonar_id(self):
        b = _make_backend("sonar")
        assert isinstance(b, _SonarBackend)
        assert b.id == "sonar"
        assert b.model == "sonar-pro"

    def test_factory_returns_anthropic_backend_for_anthropic_id(self):
        b = _make_backend("anthropic")
        assert isinstance(b, _AnthropicBackend)
        assert b.id == "anthropic"
        assert b.model == _ANTHROPIC_DEFAULT_MODEL

    def test_factory_returns_agent_api_backend_for_agent_api_id(self):
        b = _make_backend("agent-api")
        assert isinstance(b, _AgentApiBackend)
        assert b.id == "agent-api"

    def test_factory_id_is_case_insensitive(self):
        assert isinstance(_make_backend("SONAR"), _SonarBackend)
        assert isinstance(_make_backend("Anthropic"), _AnthropicBackend)
        assert isinstance(_make_backend("Agent-API"), _AgentApiBackend)

    def test_factory_raises_on_unknown_id(self):
        with pytest.raises(ValueError, match="Unknown LLM backend id"):
            _make_backend("gpt-5")
        with pytest.raises(ValueError):
            _make_backend("")

    def test_agent_api_preset_derived_from_sonar_model_when_switching(self):
        # sonar-pro -> low (per Perplexity migration table)
        b = _make_backend("agent-api", sonar_model="sonar-pro")
        assert isinstance(b, _AgentApiBackend)
        assert b.preset == "low"
        # sonar -> fast
        b = _make_backend("agent-api", sonar_model="sonar")
        assert b.preset == "fast"
        # sonar-reasoning-pro -> medium
        b = _make_backend("agent-api", sonar_model="sonar-reasoning-pro")
        assert b.preset == "medium"
        # sonar-deep-research -> high
        b = _make_backend("agent-api", sonar_model="sonar-deep-research")
        assert b.preset == "high"

    def test_agent_api_preset_unknown_sonar_model_falls_back_to_default(self):
        # A sonar_model that isn't in the mapping -> default 'low'
        b = _make_backend("agent-api", sonar_model="sonar-experimental-2029")
        assert b.preset == "low"

    def test_agent_api_explicit_preset_wins_over_derived(self):
        # Caller passes explicit preset -> always used regardless of sonar_model
        b = _make_backend("agent-api", sonar_model="sonar", agent_preset="xhigh")
        assert b.preset == "xhigh"


class TestPresetMappingConstant:
    """Guard against silent edits to the Sonar->Agent preset table.
    Source of truth: Perplexity migration docs 2026-08.
    """
    def test_preset_table_matches_perplexity_migration_doc(self):
        assert _SONAR_TO_AGENT_PRESET == {
            "sonar-pro": "low",
            "sonar": "fast",
            "sonar-reasoning-pro": "medium",
            "sonar-deep-research": "high",
        }


# ---------------------------------------------------------------------------
# Env-var routing precedence
# ---------------------------------------------------------------------------


class TestResolveBackendId:
    def test_default_is_sonar_when_no_env_vars_set(self, monkeypatch):
        monkeypatch.delenv("LLM_PRIMARY", raising=False)
        monkeypatch.delenv("LLM_PRIMARY_TOPICS", raising=False)
        assert _resolve_backend_id("topics") == "sonar"

    def test_global_primary_env_wins_over_default(self, monkeypatch):
        monkeypatch.delenv("LLM_PRIMARY_TOPICS", raising=False)
        monkeypatch.setenv("LLM_PRIMARY", "anthropic")
        assert _resolve_backend_id("topics") == "anthropic"

    def test_per_block_override_wins_over_global(self, monkeypatch):
        monkeypatch.setenv("LLM_PRIMARY", "sonar")
        monkeypatch.setenv("LLM_PRIMARY_TOPICS", "agent-api")
        assert _resolve_backend_id("topics") == "agent-api"
        # Other block still follows global
        monkeypatch.delenv("LLM_PRIMARY_SUMMARY", raising=False)
        assert _resolve_backend_id("summary") == "sonar"

    def test_per_block_uppercase_in_env_var(self, monkeypatch):
        # block_kind is lowercase; env var lookup uppercases it
        monkeypatch.setenv("LLM_PRIMARY_DIGEST", "agent-api")
        assert _resolve_backend_id("digest") == "agent-api"
        assert _resolve_backend_id("DIGEST") == "agent-api"
        assert _resolve_backend_id("Digest") == "agent-api"

    def test_returned_id_is_lowercased(self, monkeypatch):
        monkeypatch.setenv("LLM_PRIMARY", "Anthropic")
        assert _resolve_backend_id("topics") == "anthropic"

    def test_empty_env_var_falls_through_to_default(self, monkeypatch):
        # An empty string should not shadow the default
        monkeypatch.setenv("LLM_PRIMARY", "")
        monkeypatch.setenv("LLM_PRIMARY_TOPICS", "   ")  # whitespace-only
        assert _resolve_backend_id("topics") == "sonar"

    def test_missing_block_kind_still_returns_primary_default(self, monkeypatch):
        monkeypatch.delenv("LLM_PRIMARY", raising=False)
        # Empty block_kind means no per-block env var lookup
        assert _resolve_backend_id("") == "sonar"


class TestResolveFallbackId:
    def test_sonar_defaults_to_anthropic_fallback(self, monkeypatch):
        monkeypatch.delenv("LLM_FALLBACK", raising=False)
        assert _resolve_fallback_id("sonar") == "anthropic"

    def test_anthropic_defaults_to_sonar_fallback(self, monkeypatch):
        monkeypatch.delenv("LLM_FALLBACK", raising=False)
        assert _resolve_fallback_id("anthropic") == "sonar"

    def test_agent_api_defaults_to_anthropic_fallback(self, monkeypatch):
        monkeypatch.delenv("LLM_FALLBACK", raising=False)
        assert _resolve_fallback_id("agent-api") == "anthropic"

    def test_env_override_wins_over_default(self, monkeypatch):
        monkeypatch.setenv("LLM_FALLBACK", "agent-api")
        assert _resolve_fallback_id("sonar") == "agent-api"

    def test_none_env_disables_fallback(self, monkeypatch):
        monkeypatch.setenv("LLM_FALLBACK", "none")
        assert _resolve_fallback_id("sonar") is None
        monkeypatch.setenv("LLM_FALLBACK", "NONE")
        assert _resolve_fallback_id("sonar") is None
        monkeypatch.setenv("LLM_FALLBACK", "None")
        assert _resolve_fallback_id("sonar") is None


# ---------------------------------------------------------------------------
# call_llm routing
# ---------------------------------------------------------------------------


def _fake_llm_response(text: str, backend: str, model: str) -> LlmResponse:
    return LlmResponse(text=text, source=f"{backend}:{model}", backend=backend, model=model, elapsed_s=0.01, raw={})


class _FakeBackend(llm_client._Backend):
    """Deterministic in-memory backend for router tests. Never touches
    network. `should_fail` lets us simulate a primary that raises."""
    def __init__(self, backend_id: str, *, available: bool = True, should_fail: bool = False,
                 response_text: str = "ok"):
        self.id = backend_id
        self._available = available
        self._should_fail = should_fail
        self._response_text = response_text
        self.calls: list[dict[str, Any]] = []

    def available(self) -> bool:
        return self._available

    def call(self, prompt, *, system, max_tokens, temperature, disable_search, block_kind):
        self.calls.append({
            "prompt": prompt, "system": system, "max_tokens": max_tokens,
            "temperature": temperature, "disable_search": disable_search,
            "block_kind": block_kind,
        })
        if self._should_fail:
            raise RuntimeError(f"[fake {self.id}] simulated failure")
        return _fake_llm_response(self._response_text, self.id, "fake-model")


class TestCallLlmRouting:
    def test_primary_success_returns_result_without_fallback(self, monkeypatch):
        monkeypatch.setenv("LLM_PRIMARY", "sonar")
        primary = _FakeBackend("sonar", response_text="hello world")
        fallback = _FakeBackend("anthropic", response_text="fallback-should-not-be-called")

        def fake_make(bid, **_):
            return primary if bid == "sonar" else fallback

        monkeypatch.setattr(llm_client, "_make_backend", fake_make)
        resp = call_llm("test prompt", block_kind="topics")
        assert resp.text == "hello world"
        assert resp.backend == "sonar"
        assert resp.fell_back_from is None
        assert len(primary.calls) == 1
        assert len(fallback.calls) == 0

    def test_primary_fails_triggers_fallback_and_marks_fell_back_from(self, monkeypatch):
        monkeypatch.setenv("LLM_PRIMARY", "sonar")
        monkeypatch.delenv("LLM_FALLBACK", raising=False)
        primary = _FakeBackend("sonar", should_fail=True)
        fallback = _FakeBackend("anthropic", response_text="fallback response")

        def fake_make(bid, **_):
            return primary if bid == "sonar" else fallback

        monkeypatch.setattr(llm_client, "_make_backend", fake_make)
        resp = call_llm("test prompt", block_kind="topics")
        assert resp.text == "fallback response"
        assert resp.backend == "anthropic"
        assert resp.fell_back_from == "sonar"
        assert len(primary.calls) == 1
        assert len(fallback.calls) == 1

    def test_primary_unavailable_triggers_fallback_without_calling_primary(self, monkeypatch):
        monkeypatch.setenv("LLM_PRIMARY", "sonar")
        monkeypatch.delenv("LLM_FALLBACK", raising=False)
        primary = _FakeBackend("sonar", available=False)
        fallback = _FakeBackend("anthropic", response_text="anthropic served")

        def fake_make(bid, **_):
            return primary if bid == "sonar" else fallback

        monkeypatch.setattr(llm_client, "_make_backend", fake_make)
        resp = call_llm("test prompt", block_kind="topics")
        assert resp.backend == "anthropic"
        assert resp.fell_back_from == "sonar"
        assert len(primary.calls) == 0  # unavailable => never called
        assert len(fallback.calls) == 1

    def test_both_fail_raises_runtime_error(self, monkeypatch):
        monkeypatch.setenv("LLM_PRIMARY", "sonar")
        monkeypatch.delenv("LLM_FALLBACK", raising=False)
        primary = _FakeBackend("sonar", should_fail=True)
        fallback = _FakeBackend("anthropic", should_fail=True)

        def fake_make(bid, **_):
            return primary if bid == "sonar" else fallback

        monkeypatch.setattr(llm_client, "_make_backend", fake_make)
        with pytest.raises(RuntimeError, match="both primary .* and fallback .* failed"):
            call_llm("test prompt", block_kind="topics")

    def test_primary_fails_and_fallback_disabled_raises(self, monkeypatch):
        monkeypatch.setenv("LLM_PRIMARY", "sonar")
        monkeypatch.setenv("LLM_FALLBACK", "none")
        primary = _FakeBackend("sonar", should_fail=True)

        def fake_make(bid, **_):
            return primary

        monkeypatch.setattr(llm_client, "_make_backend", fake_make)
        with pytest.raises(RuntimeError, match="no usable fallback"):
            call_llm("test prompt", block_kind="topics")

    def test_primary_unavailable_and_no_fallback_raises(self, monkeypatch):
        monkeypatch.setenv("LLM_PRIMARY", "sonar")
        monkeypatch.setenv("LLM_FALLBACK", "none")
        primary = _FakeBackend("sonar", available=False)

        def fake_make(bid, **_):
            return primary

        monkeypatch.setattr(llm_client, "_make_backend", fake_make)
        with pytest.raises(RuntimeError, match="no usable fallback"):
            call_llm("test prompt", block_kind="topics")

    def test_per_block_env_var_routes_specific_block(self, monkeypatch):
        monkeypatch.setenv("LLM_PRIMARY", "sonar")
        monkeypatch.setenv("LLM_PRIMARY_TOPICS", "anthropic")
        chosen_ids: list[str] = []

        def fake_make(bid, **_):
            chosen_ids.append(bid)
            return _FakeBackend(bid)

        monkeypatch.setattr(llm_client, "_make_backend", fake_make)
        call_llm("p", block_kind="topics")
        assert chosen_ids[0] == "anthropic"    # per-block override wins
        chosen_ids.clear()
        call_llm("p", block_kind="summary")    # no override → global
        assert chosen_ids[0] == "sonar"

    def test_disable_search_defaults_true_regression_guard(self, monkeypatch):
        """Regression guard for 2026-08-18 Sonar web-search contamination
        lesson. `disable_search` MUST default to True on call_llm.
        """
        monkeypatch.setenv("LLM_PRIMARY", "sonar")
        primary = _FakeBackend("sonar")

        def fake_make(bid, **_):
            return primary

        monkeypatch.setattr(llm_client, "_make_backend", fake_make)
        call_llm("p", block_kind="topics")
        assert primary.calls[0]["disable_search"] is True

    def test_disable_search_false_passes_through(self, monkeypatch):
        monkeypatch.setenv("LLM_PRIMARY", "sonar")
        primary = _FakeBackend("sonar")

        def fake_make(bid, **_):
            return primary

        monkeypatch.setattr(llm_client, "_make_backend", fake_make)
        call_llm("p", block_kind="topics", disable_search=False)
        assert primary.calls[0]["disable_search"] is False


# ---------------------------------------------------------------------------
# Backend response parsing
# ---------------------------------------------------------------------------


class TestAnthropicBackend:
    def test_parses_multi_block_response_concatenating_text(self, monkeypatch):
        """Anthropic returns a list of content blocks; extract text from
        each TextBlock and concatenate."""
        # Fake anthropic module and client
        fake_message = SimpleNamespace(
            id="msg_test_1",
            content=[
                SimpleNamespace(text="Part one. "),
                SimpleNamespace(text="Part two."),
            ],
        )
        fake_client = MagicMock()
        fake_client.messages.create.return_value = fake_message
        fake_anthropic = MagicMock()
        fake_anthropic.Anthropic.return_value = fake_client

        monkeypatch.setitem(__import__("sys").modules, "anthropic", fake_anthropic)
        monkeypatch.setattr(llm_client.settings, "anthropic_api_key", "sk-fake")

        b = _AnthropicBackend()
        resp = b.call("hi", system=None, max_tokens=100, temperature=0.2,
                      disable_search=True, block_kind="topics")
        assert resp.text == "Part one. Part two."
        assert resp.backend == "anthropic"
        assert resp.source.startswith("anthropic:")
        # System not passed when None
        kwargs = fake_client.messages.create.call_args.kwargs
        assert "system" not in kwargs
        assert kwargs["messages"] == [{"role": "user", "content": "hi"}]

    def test_passes_system_message_when_provided(self, monkeypatch):
        fake_message = SimpleNamespace(id="m", content=[SimpleNamespace(text="ok")])
        fake_client = MagicMock()
        fake_client.messages.create.return_value = fake_message
        fake_anthropic = MagicMock()
        fake_anthropic.Anthropic.return_value = fake_client
        monkeypatch.setitem(__import__("sys").modules, "anthropic", fake_anthropic)
        monkeypatch.setattr(llm_client.settings, "anthropic_api_key", "sk-fake")

        _AnthropicBackend().call("hi", system="strict grounding", max_tokens=100,
                                 temperature=0.2, disable_search=True, block_kind="topics")
        kwargs = fake_client.messages.create.call_args.kwargs
        assert kwargs["system"] == "strict grounding"

    def test_available_false_without_key(self, monkeypatch):
        monkeypatch.setattr(llm_client.settings, "anthropic_api_key", "")
        assert _AnthropicBackend().available() is False

    def test_available_false_with_whitespace_only_key(self, monkeypatch):
        monkeypatch.setattr(llm_client.settings, "anthropic_api_key", "   ")
        assert _AnthropicBackend().available() is False


class TestAgentApiBackend:
    def test_parses_typed_output_array(self, monkeypatch):
        """Agent API returns output[] with type='message' whose content[]
        contains type='output_text' items. Extract and concatenate."""
        fake_response_body = {
            "id": "resp_test",
            "status": "completed",
            "model": "openai/gpt-5.1",
            "usage": {"input_tokens": 8, "output_tokens": 4},
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {"type": "output_text", "text": "First. "},
                        {"type": "output_text", "text": "Second."},
                    ],
                }
            ],
        }
        fake_body_bytes = json.dumps(fake_response_body).encode("utf-8")

        class FakeResp:
            def __enter__(self_inner): return self_inner
            def __exit__(self_inner, *a): pass
            def read(self_inner): return fake_body_bytes

        monkeypatch.setattr(llm_client.settings, "perplexity_api_key", "pplx-fake")
        with patch.object(llm_client.urllib.request, "urlopen", return_value=FakeResp()) as mock_open:
            resp = _AgentApiBackend(preset="low").call(
                "hi", system="be brief", max_tokens=50, temperature=0.2,
                disable_search=True, block_kind="topics",
            )
        assert resp.text == "First. Second."
        assert resp.backend == "agent-api"
        assert resp.source == "agent-api:low"
        assert resp.raw["id"] == "resp_test"
        # Verify request body shape
        req = mock_open.call_args.args[0]
        body = json.loads(req.data.decode("utf-8"))
        assert body["preset"] == "low"
        assert body["input"] == "hi"
        assert body["instructions"] == "be brief"
        assert body["max_output_tokens"] == 50
        # disable_search=True MUST omit tools[]
        assert "tools" not in body

    def test_tools_web_search_added_when_disable_search_false(self, monkeypatch):
        monkeypatch.setattr(llm_client.settings, "perplexity_api_key", "pplx-fake")
        fake_body = json.dumps({"output": [
            {"type": "message", "content": [{"type": "output_text", "text": "x"}]}
        ]}).encode("utf-8")

        class FakeResp:
            def __enter__(self_inner): return self_inner
            def __exit__(self_inner, *a): pass
            def read(self_inner): return fake_body

        with patch.object(llm_client.urllib.request, "urlopen", return_value=FakeResp()) as mock_open:
            _AgentApiBackend(preset="low").call(
                "hi", system=None, max_tokens=50, temperature=0.2,
                disable_search=False, block_kind="topics",
            )
        req = mock_open.call_args.args[0]
        body = json.loads(req.data.decode("utf-8"))
        assert body["tools"] == [{"type": "web_search"}]

    def test_available_true_with_key(self, monkeypatch):
        monkeypatch.setattr(llm_client.settings, "perplexity_api_key", "pplx-fake")
        assert _AgentApiBackend().available() is True

    def test_available_false_without_key(self, monkeypatch):
        monkeypatch.setattr(llm_client.settings, "perplexity_api_key", "")
        assert _AgentApiBackend().available() is False

    def test_http_error_raises_runtime_error_with_body_slice(self, monkeypatch):
        import urllib.error
        monkeypatch.setattr(llm_client.settings, "perplexity_api_key", "pplx-fake")
        err = urllib.error.HTTPError(
            _AGENT_API_URL, 401, "Unauthorized", {},
            io.BytesIO(b'{"error":{"message":"insufficient_quota"}}'),
        )
        with patch.object(llm_client.urllib.request, "urlopen", side_effect=err):
            with pytest.raises(RuntimeError, match="Agent API HTTP 401"):
                _AgentApiBackend().call(
                    "hi", system=None, max_tokens=50, temperature=0.2,
                    disable_search=True, block_kind="topics",
                )


# ---------------------------------------------------------------------------
# describe_routing()
# ---------------------------------------------------------------------------


class TestDescribeRouting:
    def test_reports_default_when_no_env_vars(self, monkeypatch):
        for k in list(os.environ):
            if k.startswith("LLM_"):
                monkeypatch.delenv(k, raising=False)
        r = describe_routing()
        assert r["primary_default"] == "sonar"
        assert r["fallback_default_env"] is None
        assert r["per_block_overrides"] == {}
        # All three backend descriptors are present
        assert set(r["backends"].keys()) == {"sonar", "anthropic", "agent-api"}
        assert r["backends"]["sonar"]["sunset"] == "2026-09-27"
        assert r["backends"]["sonar"]["endpoint"] == "https://api.perplexity.ai/chat/completions"
        assert r["backends"]["agent-api"]["endpoint"] == _AGENT_API_URL

    def test_captures_per_block_overrides(self, monkeypatch):
        for k in list(os.environ):
            if k.startswith("LLM_"):
                monkeypatch.delenv(k, raising=False)
        monkeypatch.setenv("LLM_PRIMARY", "anthropic")
        monkeypatch.setenv("LLM_PRIMARY_TOPICS", "agent-api")
        monkeypatch.setenv("LLM_PRIMARY_DIGEST", "sonar")
        monkeypatch.setenv("LLM_FALLBACK", "none")
        r = describe_routing()
        assert r["primary_default"] == "anthropic"
        assert r["fallback_default_env"] == "none"
        assert r["per_block_overrides"] == {"topics": "agent-api", "digest": "sonar"}
