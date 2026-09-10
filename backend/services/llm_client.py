"""Unified LLM client for SentimentPulse (and the wider Saber Suite pattern).

Landing 1 of the Sonar-deprecation migration (2026-09-10).

Why this exists
---------------
Perplexity Sonar Chat Completions is being deprecated on 2026-09-27. Today,
SentimentPulse (period summaries, Top Topics cluster sentences), SignalPulse
(leaderboard digest), and GTM Studio (translate.py) all call Sonar directly.
This module gives every caller ONE function to call and ONE place to route
the request. Backends can be swapped by env var, per-block, without touching
callers.

Design
------
- Backend implementations are private classes with a common `.call(prompt,
  system, max_tokens, temperature, disable_search) -> LlmResponse` interface.
- `call_llm(...)` picks a backend, tries it, falls back to a secondary on
  failure, and returns the same `LlmResponse` shape whichever backend won.
- `LlmResponse.content[0].text` mirrors what `sonar_client.SonarResponse`
  and `anthropic_message` both return, so existing callers don't have to
  change shape when we migrate them in Landing 2.

Routing (env vars)
------------------
- `LLM_PRIMARY` — global default backend when no per-block override is set.
  Values: `sonar` (default, preserves current behavior), `anthropic`,
  `agent-api`.
- `LLM_FALLBACK` — global fallback if the primary fails. Default: `anthropic`
  when primary is sonar; `sonar` when primary is anthropic; `anthropic`
  when primary is agent-api. Set to `none` to disable fallback.
- `LLM_PRIMARY_<BLOCK>` — per-block override. `<BLOCK>` is the uppercased
  `block_kind` passed by the caller (e.g. `LLM_PRIMARY_TOPICS`,
  `LLM_PRIMARY_SUMMARY`, `LLM_PRIMARY_DIGEST`, `LLM_PRIMARY_TRIPREPORT`).

DEFAULT BEHAVIOR IS UNCHANGED FROM PRE-LANDING-1: without setting any env
var, `LLM_PRIMARY` defaults to `sonar` and `LLM_FALLBACK` to `anthropic`,
matching what `_call_llm_for_user_block` already did. Landing 1 is a
no-op in production until an operator sets an override.

The Sept 27 sunset plan: flip `LLM_PRIMARY` to `anthropic` (or `agent-api`
once QA passes) via one env var change on the droplet. No code deploy.
"""
from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional

from config import settings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Shared response envelope
# ---------------------------------------------------------------------------


@dataclass
class LlmResponse:
    """Uniform response for every backend. Shape mirrors the old
    `_LLMResponse` in period_summary_service.py so calls that read
    `.content[0].text` keep working during Landing 2."""
    text: str
    source: str                             # e.g. "sonar:sonar-pro"
    backend: str                            # canonical id: sonar|anthropic|agent-api
    model: str                              # backend-specific model or preset
    elapsed_s: float = 0.0
    raw: dict[str, Any] = field(default_factory=dict)
    fell_back_from: Optional[str] = None    # populated on fallback wins

    @property
    def content(self) -> list["_LlmContentBlock"]:
        return [_LlmContentBlock(text=self.text)]


@dataclass
class _LlmContentBlock:
    text: str


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------


class _Backend:
    """Common interface. Concrete backends implement `available()` and
    `call()`; the router treats them polymorphically."""
    id: str = ""

    def available(self) -> bool:
        raise NotImplementedError

    def call(self, prompt: str, *, system: Optional[str], max_tokens: int,
             temperature: float, disable_search: bool, block_kind: str) -> LlmResponse:
        raise NotImplementedError


# --- Sonar Chat Completions (existing wrapper) ------------------------------


class _SonarBackend(_Backend):
    """Wraps the existing services/sonar_client.call_sonar. No behavior
    change vs pre-Landing-1."""
    id = "sonar"

    def __init__(self, model: str = "sonar-pro"):
        self.model = model

    def available(self) -> bool:
        try:
            from services.sonar_client import sonar_available
            return sonar_available()
        except ImportError as e:
            logger.warning("[llm_client] sonar_client import failed: %s", e)
            return False

    def call(self, prompt: str, *, system, max_tokens, temperature,
             disable_search, block_kind) -> LlmResponse:
        from services.sonar_client import call_sonar
        started = time.monotonic()
        resp = call_sonar(
            prompt,
            model=self.model,
            system=system,
            max_tokens=max_tokens,
            temperature=temperature,
            disable_search=disable_search,
        )
        elapsed = time.monotonic() - started
        return LlmResponse(
            text=resp.text,
            source=f"sonar:{self.model}",
            backend=self.id,
            model=self.model,
            elapsed_s=elapsed,
            raw=getattr(resp, "raw", {}) or {},
        )


# --- Anthropic Claude (already the fallback in period_summary_service) ------


_ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5-20251001"


class _AnthropicBackend(_Backend):
    """Direct Anthropic call. Mirrors the fallback branch of the existing
    _call_llm_for_user_block. Model default matches _MODEL in
    period_summary_service.py so we don't accidentally change quality."""
    id = "anthropic"

    def __init__(self, model: str = _ANTHROPIC_DEFAULT_MODEL):
        self.model = model

    def available(self) -> bool:
        if not (settings.anthropic_api_key or "").strip():
            return False
        try:
            import anthropic  # noqa: F401
            return True
        except ImportError:
            return False

    def call(self, prompt: str, *, system, max_tokens, temperature,
             disable_search, block_kind) -> LlmResponse:
        # `disable_search` has no meaning for Anthropic — the model has no
        # native web tool. Silently ignore.
        import anthropic
        client = anthropic.Anthropic(
            api_key=settings.anthropic_api_key,
            base_url="https://api.anthropic.com",
        )
        started = time.monotonic()
        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system:
            kwargs["system"] = system
        message = client.messages.create(**kwargs)
        elapsed = time.monotonic() - started
        text = ""
        if message.content:
            # Anthropic returns a list of content blocks; text lives in
            # block.text for TextBlocks. Concatenate all TextBlocks.
            text_parts: list[str] = []
            for block in message.content:
                if hasattr(block, "text"):
                    text_parts.append(block.text)
            text = "".join(text_parts)
        return LlmResponse(
            text=text,
            source=f"anthropic:{self.model}",
            backend=self.id,
            model=self.model,
            elapsed_s=elapsed,
            raw={"id": getattr(message, "id", None)},
        )


# --- Perplexity Agent API (post-sunset replacement path) --------------------


_AGENT_API_URL = "https://api.perplexity.ai/v1/agent"
_AGENT_API_DEFAULT_PRESET = "low"   # Sonar Pro -> `low` per Perplexity migration guide
_AGENT_API_DEFAULT_TIMEOUT = 180


class _AgentApiBackend(_Backend):
    """Perplexity Agent API — the post-Sept-27 replacement for Sonar Chat
    Completions. Uses the same PERPLEXITY_API_KEY as Sonar.

    Wire format differs from Sonar: request has `input` + `preset` instead
    of `messages` + `model`; response has typed `output[]` with an
    `output_text` convenience field via the SDK, but we hit the raw HTTP
    endpoint so we extract from `output[].content[].text` ourselves.

    Preset defaults follow Perplexity's own migration table:
        sonar          -> fast
        sonar-pro      -> low
        sonar-reasoning-pro -> medium
        sonar-deep-research -> high
    """
    id = "agent-api"

    def __init__(self, preset: str = _AGENT_API_DEFAULT_PRESET,
                 timeout: int = _AGENT_API_DEFAULT_TIMEOUT):
        self.preset = preset
        self.timeout = timeout

    def available(self) -> bool:
        return bool((settings.perplexity_api_key or "").strip())

    def call(self, prompt: str, *, system, max_tokens, temperature,
             disable_search, block_kind) -> LlmResponse:
        key = (settings.perplexity_api_key or "").strip()
        if not key:
            raise RuntimeError("Agent API: PERPLEXITY_API_KEY not configured")

        # Agent API uses a top-level `input` string and a top-level
        # `instructions` string for behavior guidance (docs say the old
        # `system` message maps here). It also uses a `tools` array to
        # enable web_search — omit it entirely when disable_search=True.
        body: dict[str, Any] = {
            "preset": self.preset,
            "input": prompt,
            "max_output_tokens": max_tokens,
        }
        if system:
            body["instructions"] = system
        if not disable_search:
            body["tools"] = [{"type": "web_search"}]

        req = urllib.request.Request(
            _AGENT_API_URL,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
                "Accept": "application/json",
            },
            method="POST",
        )
        started = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw_bytes = resp.read()
        except urllib.error.HTTPError as e:
            err_body = ""
            try:
                err_body = e.read().decode("utf-8", errors="replace")[:500]
            except Exception:
                pass
            raise RuntimeError(f"Agent API HTTP {e.code}: {e.reason} | body={err_body!r}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"Agent API URLError: {e.reason}") from e
        elapsed = time.monotonic() - started

        try:
            parsed = json.loads(raw_bytes.decode("utf-8"))
        except Exception as e:
            raise RuntimeError(f"Agent API response not JSON: {e}") from e

        # Extract answer text from the typed output[] structure. Per docs:
        # response.output[] contains items; the assistant answer is
        # type='message' with content=[{'type':'output_text','text':...}].
        text_parts: list[str] = []
        for item in parsed.get("output", []) or []:
            if item.get("type") != "message":
                continue
            for c in item.get("content", []) or []:
                if c.get("type") == "output_text":
                    t = c.get("text")
                    if isinstance(t, str) and t:
                        text_parts.append(t)
        text = "".join(text_parts)
        # SDK-style convenience field, if present.
        if not text and isinstance(parsed.get("output_text"), str):
            text = parsed["output_text"]

        return LlmResponse(
            text=text,
            source=f"agent-api:{self.preset}",
            backend=self.id,
            model=self.preset,
            elapsed_s=elapsed,
            raw={
                "id": parsed.get("id"),
                "status": parsed.get("status"),
                "usage": parsed.get("usage"),
                "model": parsed.get("model"),
            },
        )


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


# Sonar Pro / Sonar / Reasoning Pro / Deep Research → Agent API presets.
# Used only when the caller doesn't explicitly override the preset.
_SONAR_TO_AGENT_PRESET = {
    "sonar-pro": "low",
    "sonar": "fast",
    "sonar-reasoning-pro": "medium",
    "sonar-deep-research": "high",
}


def _resolve_backend_id(block_kind: str) -> str:
    """Pick the primary backend for this block. Precedence:
      1. LLM_PRIMARY_<BLOCK> env var (block-specific override)
      2. LLM_PRIMARY env var
      3. `sonar` (unchanged legacy default)
    """
    if block_kind:
        override = os.environ.get(f"LLM_PRIMARY_{block_kind.upper()}", "").strip()
        if override:
            return override.lower()
    return (os.environ.get("LLM_PRIMARY", "").strip() or "sonar").lower()


def _resolve_fallback_id(primary_id: str) -> Optional[str]:
    """Pick the fallback backend. `none` (case-insensitive) disables
    fallback. If the operator sets LLM_FALLBACK to the same value as
    primary, that's their choice — we don't second-guess."""
    override = os.environ.get("LLM_FALLBACK", "").strip().lower()
    if override:
        return None if override == "none" else override
    # Sensible defaults per primary.
    if primary_id == "sonar":
        return "anthropic"
    if primary_id == "anthropic":
        return "sonar"
    if primary_id == "agent-api":
        return "anthropic"
    return "anthropic"


def _make_backend(backend_id: str, *, sonar_model: str = "sonar-pro",
                  anthropic_model: str = _ANTHROPIC_DEFAULT_MODEL,
                  agent_preset: Optional[str] = None) -> _Backend:
    """Factory. When switching from sonar to agent-api on the same call site,
    we default the agent-api preset from the sonar model name using the
    Perplexity migration table above, so the operator doesn't have to
    manually pick presets in env vars."""
    bid = backend_id.lower()
    if bid == "sonar":
        return _SonarBackend(model=sonar_model)
    if bid == "anthropic":
        return _AnthropicBackend(model=anthropic_model)
    if bid == "agent-api":
        preset = agent_preset or _SONAR_TO_AGENT_PRESET.get(sonar_model, _AGENT_API_DEFAULT_PRESET)
        return _AgentApiBackend(preset=preset)
    raise ValueError(f"Unknown LLM backend id: {backend_id!r} (expected one of: sonar, anthropic, agent-api)")


def call_llm(
    prompt: str,
    *,
    block_kind: str,
    system: Optional[str] = None,
    max_tokens: int = 1024,
    temperature: float = 0.2,
    disable_search: bool = True,
    sonar_model: str = "sonar-pro",
    anthropic_model: str = _ANTHROPIC_DEFAULT_MODEL,
    agent_preset: Optional[str] = None,
) -> LlmResponse:
    """Route ONE prompt through the configured primary backend, falling back
    to the secondary if the primary fails or is unavailable.

    Args:
      prompt: The full user prompt.
      block_kind: Short identifier for which product block this call powers.
        Examples: "topics", "period_summary", "digest", "translate",
        "tripreport". Used for the per-block env var override
        (`LLM_PRIMARY_<BLOCK>`).
      system: Optional system message / instructions.
      max_tokens: Cap on response length. Sonar and Anthropic honor
        `max_tokens`; Agent API uses `max_output_tokens`; we translate.
      temperature: Sampling temperature.
      disable_search: For Sonar and Agent API, this disables web-search
        blending. Ignored by Anthropic (no native web tool). Default True
        because every current caller grounds strictly on user context.
      sonar_model: Sonar model. Also drives the default Agent API preset
        when the primary is agent-api.
      anthropic_model: Claude model. Default is haiku-class (fastest);
        callers that need Sonnet-class quality pass it explicitly.
      agent_preset: Explicit Agent API preset override. When omitted, we
        derive it from `sonar_model` via _SONAR_TO_AGENT_PRESET.

    Raises RuntimeError only if BOTH primary and fallback fail (or fallback
    is disabled and primary fails). Callers already wrap in try/except and
    fall back to placeholder text on exception (matches pre-Landing-1
    behavior)."""
    primary_id = _resolve_backend_id(block_kind)
    fallback_id = _resolve_fallback_id(primary_id)

    primary = _make_backend(primary_id, sonar_model=sonar_model,
                            anthropic_model=anthropic_model, agent_preset=agent_preset)

    # Attempt primary. If it's simply unavailable (no key), treat that as a
    # failure and try fallback — but log at info, not warning.
    primary_error: Optional[BaseException] = None
    if primary.available():
        try:
            resp = primary.call(
                prompt,
                system=system,
                max_tokens=max_tokens,
                temperature=temperature,
                disable_search=disable_search,
                block_kind=block_kind,
            )
            logger.info(
                "LLM[%s] via %s (resp_chars=%d, elapsed=%.2fs)",
                block_kind or "?", resp.source, len(resp.text), resp.elapsed_s,
            )
            return resp
        except Exception as exc:
            primary_error = exc
            logger.warning(
                "LLM[%s] primary %s failed (%s) — trying fallback %s",
                block_kind or "?", primary_id, exc, fallback_id or "none",
            )
    else:
        logger.info(
            "LLM[%s] primary %s unavailable (no key / import failure) — trying fallback %s",
            block_kind or "?", primary_id, fallback_id or "none",
        )

    if fallback_id and fallback_id != primary_id:
        fallback = _make_backend(fallback_id, sonar_model=sonar_model,
                                 anthropic_model=anthropic_model, agent_preset=agent_preset)
        if fallback.available():
            try:
                resp = fallback.call(
                    prompt,
                    system=system,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    disable_search=disable_search,
                    block_kind=block_kind,
                )
                resp.fell_back_from = primary_id
                logger.info(
                    "LLM[%s] via %s (FALLBACK from %s, resp_chars=%d, elapsed=%.2fs)",
                    block_kind or "?", resp.source, primary_id, len(resp.text), resp.elapsed_s,
                )
                return resp
            except Exception as exc:
                raise RuntimeError(
                    f"LLM[{block_kind}] both primary ({primary_id}: {primary_error}) "
                    f"and fallback ({fallback_id}: {exc}) failed"
                ) from exc

    raise RuntimeError(
        f"LLM[{block_kind}] primary={primary_id} failed/unavailable "
        f"({primary_error}) and no usable fallback (fallback={fallback_id!r})"
    )


# ---------------------------------------------------------------------------
# Diagnostic helpers — used by /api/diag/llm/status
# ---------------------------------------------------------------------------


def describe_routing() -> dict[str, Any]:
    """Report current routing configuration for the diagnostic endpoint.
    Reads only env vars + settings; no live probe."""
    per_block: dict[str, str] = {}
    for k, v in os.environ.items():
        if k.startswith("LLM_PRIMARY_") and v.strip():
            per_block[k[len("LLM_PRIMARY_"):].lower()] = v.strip().lower()
    return {
        "primary_default": (os.environ.get("LLM_PRIMARY", "").strip() or "sonar").lower(),
        "fallback_default_env": os.environ.get("LLM_FALLBACK", "").strip().lower() or None,
        "per_block_overrides": per_block,
        "backends": {
            "sonar": {
                "available": _SonarBackend().available(),
                "endpoint": "https://api.perplexity.ai/chat/completions",
                "sunset": "2026-09-27",
            },
            "anthropic": {
                "available": _AnthropicBackend().available(),
                "endpoint": "https://api.anthropic.com/v1/messages",
                "sunset": None,
            },
            "agent-api": {
                "available": _AgentApiBackend().available(),
                "endpoint": _AGENT_API_URL,
                "sunset": None,
                "note": "Post-2026-09-27 replacement for Sonar Chat Completions.",
            },
        },
    }
