"""Tests for the Landing 6 bake-off harness (scripts/llm_bakeoff.py).

The harness itself is I/O + LLM-router glue; there's no domain logic to
test in isolation for the network calls. What CAN be pinned without a
real key are:

- `_forced_backend` correctly sets/restores the per-block env var and the
  fallback env var (regression: a bad restore would leak between prompts).
- `_run_one` captures both success and exception paths into a CallResult
  (regression: a raised backend must not crash the whole run).
- `_emit_markdown` produces a report that includes the summary table row
  for each prompt/backend combo and inlines errors on failure.
- The `PROMPTS` fixture contains one entry per production block we plan
  to migrate (topics, digest, period_summary, translate), each with a
  fresh `block_kind` prefixed BAKEOFF_ so it can't collide with real
  block env vars.
"""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest

# The harness is a runnable module under scripts/. Import via its path.
import sys
from pathlib import Path
_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from scripts import llm_bakeoff  # noqa: E402
from services.llm_client import LlmResponse  # noqa: E402


# ---------------------------------------------------------------------------
# _forced_backend
# ---------------------------------------------------------------------------


class TestForcedBackend:
    def test_sets_and_restores_env(self, monkeypatch):
        monkeypatch.delenv("LLM_PRIMARY_TEST_BLOCK", raising=False)
        monkeypatch.delenv("LLM_FALLBACK", raising=False)
        with llm_bakeoff._forced_backend("TEST_BLOCK", "agent-api"):
            assert os.environ["LLM_PRIMARY_TEST_BLOCK"] == "agent-api"
            assert os.environ["LLM_FALLBACK"] == "none"
        # Both unset again.
        assert "LLM_PRIMARY_TEST_BLOCK" not in os.environ
        assert "LLM_FALLBACK" not in os.environ

    def test_restores_prior_value_if_set(self, monkeypatch):
        monkeypatch.setenv("LLM_PRIMARY_TEST_BLOCK", "sonar")
        monkeypatch.setenv("LLM_FALLBACK", "anthropic")
        with llm_bakeoff._forced_backend("TEST_BLOCK", "agent-api"):
            assert os.environ["LLM_PRIMARY_TEST_BLOCK"] == "agent-api"
            assert os.environ["LLM_FALLBACK"] == "none"
        # Restored to the pre-existing values, not deleted.
        assert os.environ["LLM_PRIMARY_TEST_BLOCK"] == "sonar"
        assert os.environ["LLM_FALLBACK"] == "anthropic"

    def test_restore_even_on_exception(self, monkeypatch):
        monkeypatch.delenv("LLM_PRIMARY_TEST_BLOCK", raising=False)
        with pytest.raises(RuntimeError):
            with llm_bakeoff._forced_backend("TEST_BLOCK", "agent-api"):
                assert os.environ["LLM_PRIMARY_TEST_BLOCK"] == "agent-api"
                raise RuntimeError("boom")
        assert "LLM_PRIMARY_TEST_BLOCK" not in os.environ

    def test_block_kind_is_uppercased_for_env_var(self, monkeypatch):
        monkeypatch.delenv("LLM_PRIMARY_LOWERCASE_BLOCK", raising=False)
        with llm_bakeoff._forced_backend("lowercase_block", "sonar"):
            assert os.environ["LLM_PRIMARY_LOWERCASE_BLOCK"] == "sonar"
        assert "LLM_PRIMARY_LOWERCASE_BLOCK" not in os.environ


# ---------------------------------------------------------------------------
# _run_one — success and failure paths
# ---------------------------------------------------------------------------


class TestRunOne:
    def _mkprompt(self, block_kind: str = "BAKEOFF_UT") -> llm_bakeoff.Prompt:
        return llm_bakeoff.Prompt(
            name="ut",
            block_kind=block_kind,
            system="sys",
            prompt="prompt",
            max_tokens=100,
            temperature=0.2,
            disable_search=True,
        )

    def test_success_captures_text_and_elapsed(self, monkeypatch):
        monkeypatch.delenv("LLM_PRIMARY_BAKEOFF_UT", raising=False)

        def _fake_call_llm(prompt, *, block_kind, **kwargs):
            return LlmResponse(
                text="hi there",
                source="agent-api:preset=low",
                backend="agent-api",
                model="preset=low",
                elapsed_s=0.42,
            )

        with patch.object(llm_bakeoff, "call_llm", side_effect=_fake_call_llm):
            r = llm_bakeoff._run_one(self._mkprompt(), "agent-api")

        assert r.ok is True
        assert r.text == "hi there"
        assert r.error is None
        assert r.source_label == "agent-api:preset=low"
        assert r.elapsed_s >= 0.0  # monotonic-measured, not response.elapsed_s
        assert r.fell_back_from is None

    def test_backend_exception_is_captured_not_raised(self, monkeypatch):
        monkeypatch.delenv("LLM_PRIMARY_BAKEOFF_UT", raising=False)

        def _fake_call_llm(prompt, *, block_kind, **kwargs):
            raise RuntimeError("HTTP 429 rate limited")

        with patch.object(llm_bakeoff, "call_llm", side_effect=_fake_call_llm):
            r = llm_bakeoff._run_one(self._mkprompt(), "sonar")

        assert r.ok is False
        assert r.text == ""
        assert r.error is not None
        assert "HTTP 429" in r.error
        assert r.source_label == "sonar:error"

    def test_fallback_information_is_propagated(self, monkeypatch):
        monkeypatch.delenv("LLM_PRIMARY_BAKEOFF_UT", raising=False)

        def _fake_call_llm(prompt, *, block_kind, **kwargs):
            return LlmResponse(
                text="from fallback",
                source="anthropic:claude-haiku",
                backend="anthropic",
                model="claude-haiku",
                elapsed_s=0.9,
                fell_back_from="sonar",
            )

        with patch.object(llm_bakeoff, "call_llm", side_effect=_fake_call_llm):
            r = llm_bakeoff._run_one(self._mkprompt(), "sonar")

        # Note: even though `_forced_backend` disables fallback, if it fires
        # for some other reason we still want to see it flagged in the report.
        assert r.fell_back_from == "sonar"


# ---------------------------------------------------------------------------
# _emit_markdown
# ---------------------------------------------------------------------------


class TestEmitMarkdown:
    def _mk_result(self, backend, ok, text="ok text", error=None,
                   source=None, fell_back_from=None, elapsed=0.5) -> llm_bakeoff.CallResult:
        return llm_bakeoff.CallResult(
            backend=backend,
            ok=ok,
            text=text,
            elapsed_s=elapsed,
            error=error,
            source_label=source or f"{backend}:model",
            fell_back_from=fell_back_from,
        )

    def test_report_contains_summary_row_per_prompt(self):
        prompts = [llm_bakeoff.PROMPTS[0], llm_bakeoff.PROMPTS[1]]
        results = {
            prompts[0].name: {b: self._mk_result(b, True, text=f"{b} said hi") for b in llm_bakeoff.BACKENDS},
            prompts[1].name: {b: self._mk_result(b, True, text=f"{b} said hi again") for b in llm_bakeoff.BACKENDS},
        }
        md = llm_bakeoff._emit_markdown(prompts, results)
        assert "## Summary" in md
        # Summary table row per prompt
        assert f"| **{prompts[0].name}** |" in md
        assert f"| **{prompts[1].name}** |" in md
        # Detail sections
        assert f"## Block: `{prompts[0].name}`" in md
        # Each backend output rendered
        for b in llm_bakeoff.BACKENDS:
            assert f"{b}:model" in md

    def test_failure_is_shown_in_report(self):
        prompts = [llm_bakeoff.PROMPTS[0]]
        results = {
            prompts[0].name: {
                "sonar": self._mk_result("sonar", True, text="alive"),
                "anthropic": self._mk_result(
                    "anthropic", False, error="ConnectionError: timed out",
                    source="anthropic:error",
                ),
                "agent-api": self._mk_result("agent-api", True, text="alive"),
            },
        }
        md = llm_bakeoff._emit_markdown(prompts, results)
        # Summary shows FAIL for anthropic
        assert "FAIL" in md
        # Detail contains the error message
        assert "ConnectionError" in md

    def test_report_notes_fallback_when_it_fires(self):
        prompts = [llm_bakeoff.PROMPTS[0]]
        results = {
            prompts[0].name: {
                "sonar": self._mk_result("sonar", True, fell_back_from="agent-api"),
                "anthropic": self._mk_result("anthropic", True),
                "agent-api": self._mk_result("agent-api", True),
            },
        }
        md = llm_bakeoff._emit_markdown(prompts, results)
        assert "fallback fired from" in md


# ---------------------------------------------------------------------------
# PROMPTS fixture invariants
# ---------------------------------------------------------------------------


class TestPromptsFixture:
    def test_covers_every_production_block(self):
        """We migrate topics, digest, period_summary, translate. All four
        must appear in PROMPTS so the bake-off doesn't leave any block
        unrepresented before the Sept 27 cutover."""
        names = {p.name for p in llm_bakeoff.PROMPTS}
        assert names == {"topics", "digest", "period_summary", "translate"}

    def test_block_kinds_are_bakeoff_prefixed(self):
        """block_kind must be BAKEOFF_* so setting LLM_PRIMARY_<BLOCK_KIND>
        cannot collide with any real production block env var
        (LLM_PRIMARY_TOPICS, LLM_PRIMARY_DIGEST, etc.)."""
        for p in llm_bakeoff.PROMPTS:
            assert p.block_kind.startswith("BAKEOFF_"), \
                f"prompt '{p.name}' has block_kind={p.block_kind}, must start with BAKEOFF_"

    def test_all_prompts_disable_search_by_default(self):
        """Every production caller currently sets disable_search=True and
        grounds strictly on user context. The bake-off must mirror that so
        the comparison is honest."""
        for p in llm_bakeoff.PROMPTS:
            assert p.disable_search is True, f"{p.name} has disable_search=False"

    def test_block_kinds_are_unique(self):
        kinds = [p.block_kind for p in llm_bakeoff.PROMPTS]
        assert len(set(kinds)) == len(kinds)


# ---------------------------------------------------------------------------
# BACKENDS constant
# ---------------------------------------------------------------------------


def test_backends_list_covers_all_three_llm_client_options():
    """If we add a fourth backend to services.llm_client (e.g. openai),
    someone should notice this test fails and update PROMPTS accordingly."""
    assert set(llm_bakeoff.BACKENDS) == {"sonar", "anthropic", "agent-api"}
