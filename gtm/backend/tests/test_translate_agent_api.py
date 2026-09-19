"""Tests for Landing 4 (2026-09-19) of the Sonar-deprecation migration.

Perplexity Sonar Chat Completions is being deprecated on 2026-09-27. This
file pins the Agent API branch added to gtm_pack/translate.py:

- Router (_selected_backend + _call_llm) picks the right backend per env var
- Agent API wire body matches Perplexity's official migration guide (preset,
  instructions, input, max_output_tokens; NO web-search tools since
  translation doesn't need them)
- Sonar-default wire body stays unchanged (regression guard for production)
- Response walker handles happy path, malformed shapes, empty output
- Failure surface still raises RuntimeError so translate_form_inputs()'s
  try/except keeps working for both backends
"""
from __future__ import annotations

import io
import json
import os
from unittest.mock import patch, MagicMock

import pytest

# translate.py imports 'config' transitively via nothing else in gtm_pack \u2014 verify
# import at module level so any import-time regression surfaces immediately.
from gtm_pack.translate import (
    _call_agent_api,
    _call_llm,
    _extract_agent_text,
    _selected_backend,
    _SonarResponse,
    call_sonar,
)


# ---------------------------------------------------------------------------
# _selected_backend
# ---------------------------------------------------------------------------


class TestSelectedBackend:
    def test_default_is_sonar(self, monkeypatch):
        monkeypatch.delenv("LLM_PRIMARY_TRANSLATE", raising=False)
        monkeypatch.delenv("LLM_PRIMARY", raising=False)
        assert _selected_backend() == "sonar"

    def test_translate_specific_env_wins_over_global(self, monkeypatch):
        monkeypatch.setenv("LLM_PRIMARY", "sonar")
        monkeypatch.setenv("LLM_PRIMARY_TRANSLATE", "agent-api")
        assert _selected_backend() == "agent-api"

    def test_global_llm_primary_is_honored(self, monkeypatch):
        monkeypatch.delenv("LLM_PRIMARY_TRANSLATE", raising=False)
        monkeypatch.setenv("LLM_PRIMARY", "agent-api")
        assert _selected_backend() == "agent-api"

    def test_typo_falls_back_to_sonar(self, monkeypatch):
        """Explicit test: an env-var typo can't silently break translation."""
        monkeypatch.setenv("LLM_PRIMARY_TRANSLATE", "agentapi")  # missing hyphen
        assert _selected_backend() == "sonar"

    def test_empty_string_falls_back_to_sonar(self, monkeypatch):
        monkeypatch.setenv("LLM_PRIMARY_TRANSLATE", "")
        assert _selected_backend() == "sonar"


# ---------------------------------------------------------------------------
# _extract_agent_text
# ---------------------------------------------------------------------------


class TestExtractAgentText:
    def test_extracts_first_message_content_text(self):
        parsed = {
            "output": [
                {"type": "search_results", "results": []},
                {"type": "message", "content": [{"text": "  hello world  "}]},
            ]
        }
        assert _extract_agent_text(parsed) == "hello world"

    def test_falls_back_to_output_text(self):
        assert _extract_agent_text({"output": [], "output_text": "fallback"}) == "fallback"

    def test_empty_on_malformed(self):
        assert _extract_agent_text({}) == ""
        assert _extract_agent_text({"output": "not-a-list"}) == ""
        assert _extract_agent_text({"output": [{"type": "message", "content": []}]}) == ""
        assert _extract_agent_text(
            {"output": [{"type": "message", "content": [{"text": "   "}]}]}
        ) == ""


# ---------------------------------------------------------------------------
# _call_agent_api wire body
# ---------------------------------------------------------------------------


def _make_urlopen_stub(payload: dict, status: int = 200):
    """Return a context-manager-like stub for urllib.request.urlopen."""
    resp = MagicMock()
    resp.read.return_value = json.dumps(payload).encode("utf-8")
    resp.__enter__ = MagicMock(return_value=resp)
    resp.__exit__ = MagicMock(return_value=False)
    return resp


class TestAgentApiWireBody:
    def test_body_matches_migration_guide(self, monkeypatch):
        monkeypatch.setenv("PERPLEXITY_API_KEY", "test-key")
        captured = {}

        def _fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["headers"] = dict(req.header_items())
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _make_urlopen_stub({
                "output": [{"type": "message", "content": [{"text": "ok"}]}]
            })

        with patch("gtm_pack.translate._urllib_request.urlopen", side_effect=_fake_urlopen):
            r = _call_agent_api("hello", system="be brief", max_tokens=1000)

        assert r.text == "ok"
        assert captured["url"] == "https://api.perplexity.ai/v1/agent"

        b = captured["body"]
        # Field renames per migration guide
        assert b["preset"] == "low", "sonar-pro behavioral match is preset='low'"
        assert b["instructions"] == "be brief", "system prompt migrates to top-level instructions"
        assert b["input"] == [{"role": "user", "content": "hello"}]
        assert b["max_output_tokens"] == 1000, "max_tokens migrates to max_output_tokens"
        assert b["temperature"] == 0.2

        # Sonar-only fields must be absent (Agent API rejects unknown top-level fields with HTTP 400)
        assert "messages" not in b
        assert "model" not in b
        assert "max_tokens" not in b
        assert "web_search_options" not in b
        # Translation doesn't need web search, so no tools block should be sent
        assert "tools" not in b

    def test_no_api_key_raises(self, monkeypatch):
        monkeypatch.delenv("PERPLEXITY_API_KEY", raising=False)
        with pytest.raises(RuntimeError, match="not configured"):
            _call_agent_api("hi")

    def test_empty_response_raises(self, monkeypatch):
        monkeypatch.setenv("PERPLEXITY_API_KEY", "k")

        def _fake_urlopen(req, timeout=None):
            return _make_urlopen_stub({"output": []})

        with patch("gtm_pack.translate._urllib_request.urlopen", side_effect=_fake_urlopen):
            with pytest.raises(RuntimeError, match="missing message text"):
                _call_agent_api("hi")

    def test_http_error_raises_runtime_error(self, monkeypatch):
        monkeypatch.setenv("PERPLEXITY_API_KEY", "k")
        import urllib.error

        def _fake_urlopen(req, timeout=None):
            raise urllib.error.HTTPError(
                url=req.full_url, code=500, msg="boom", hdrs={}, fp=io.BytesIO(b"error body")
            )

        with patch("gtm_pack.translate._urllib_request.urlopen", side_effect=_fake_urlopen):
            with pytest.raises(RuntimeError, match=r"Agent API HTTP 500"):
                _call_agent_api("hi")


# ---------------------------------------------------------------------------
# Sonar-default regression guard
# ---------------------------------------------------------------------------


class TestSonarDefaultUnchanged:
    def test_sonar_wire_body_still_uses_messages(self, monkeypatch):
        """Regression: production keeps hitting Sonar with the same shape
        until an operator flips the env flag."""
        monkeypatch.setenv("PERPLEXITY_API_KEY", "k")
        captured = {}

        def _fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _make_urlopen_stub({
                "choices": [{"message": {"content": "sonar output"}}]
            })

        with patch("gtm_pack.translate._urllib_request.urlopen", side_effect=_fake_urlopen):
            r = call_sonar("hi")

        assert r.text == "sonar output"
        assert captured["url"] == "https://api.perplexity.ai/chat/completions"

        b = captured["body"]
        assert b["model"] == "sonar-pro"
        assert isinstance(b["messages"], list)
        assert "preset" not in b
        assert "instructions" not in b
        assert "input" not in b


# ---------------------------------------------------------------------------
# _call_llm router
# ---------------------------------------------------------------------------


class TestCallLlmRouter:
    def test_default_env_routes_to_sonar(self, monkeypatch):
        monkeypatch.delenv("LLM_PRIMARY_TRANSLATE", raising=False)
        monkeypatch.delenv("LLM_PRIMARY", raising=False)
        with patch("gtm_pack.translate.call_sonar") as mock_sonar, \
             patch("gtm_pack.translate._call_agent_api") as mock_agent:
            mock_sonar.return_value = _SonarResponse(text="sonar")
            r = _call_llm("hi")
        assert r.text == "sonar"
        assert mock_sonar.call_count == 1
        assert mock_agent.call_count == 0

    def test_agent_api_env_routes_to_agent(self, monkeypatch):
        monkeypatch.setenv("LLM_PRIMARY_TRANSLATE", "agent-api")
        with patch("gtm_pack.translate.call_sonar") as mock_sonar, \
             patch("gtm_pack.translate._call_agent_api") as mock_agent:
            mock_agent.return_value = _SonarResponse(text="agent")
            r = _call_llm("hi")
        assert r.text == "agent"
        assert mock_sonar.call_count == 0
        assert mock_agent.call_count == 1

    def test_agent_api_does_not_receive_search_context_size(self, monkeypatch):
        """Regression: _call_agent_api's signature does not accept
        search_context_size (translation doesn't need web search). The
        router must swallow that kwarg before dispatching."""
        monkeypatch.setenv("LLM_PRIMARY_TRANSLATE", "agent-api")
        with patch("gtm_pack.translate._call_agent_api") as mock_agent:
            mock_agent.return_value = _SonarResponse(text="agent")
            _call_llm("hi", search_context_size="high")
        kwargs = mock_agent.call_args.kwargs
        assert "search_context_size" not in kwargs
