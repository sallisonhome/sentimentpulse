"""Phase 4.2 — Russian localization translation service.

`translate_form_inputs(inputs, target_lang="ru")` takes a FormInputs-shaped
dict (see main.py's `FormInputs` Pydantic model / `_form_inputs_to_render_dict`)
and returns a new dict with the same shape, where every user-authored free-text
field has been translated to the target language via a single Sonar call, and
every non-text / numeric / structural field is passed through UNCHANGED.

Design goals (per gtm_revisions_summary.md Phase 4 spec):
  - ONE Sonar call per deck translation (not one call per field) to keep
    latency and cost bounded — the whole FormInputs blob is translated in a
    single structured JSON-in/JSON-out round trip.
  - A strict field allow-list / deny-list (below) so numeric, ID, and
    structural fields can NEVER be corrupted by translation, even if the LLM
    hallucinates or reformats. We ONLY ever read back the allow-listed keys
    from Sonar's response; every other key is copied verbatim from the input.
  - Roadmap slide copy is NOT translated via Sonar at all. It's sourced from
    a pre-translated static asset (`assets/roadmap_phases_ru.json`), because
    the roadmap's ~90 lines of checklist copy is fixed content shared across
    every deck, not per-deck user input — see render_roadmap.py / __init__.py
    render_roadmap() `phases_override` parameter. Callers translating a deck
    should pass `roadmap_phases_ru.json` as `phases_override` to
    `render_pack_with_artifacts(..., language="ru")` separately; this module
    does not touch roadmap phases at all.

Currency / numeric fields are on the deny-list and must NEVER be sent through
an LLM rewrite: median_revenue_usd_millions, avg_price_usd, median_units_sold,
avg_hours_played, cohorts[].size, release_date, platforms, game_type, inner,
threat_level, enabled flags, and all ID-like fields.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

try:
    from backend.services.sonar_client import call_sonar, sonar_available
except ImportError:  # pragma: no cover - path layout fallback
    import sys as _sys

    _repo_root = Path(__file__).resolve().parents[3]  # .../sentimentpulse
    _sys.path.insert(0, str(_repo_root / "backend"))
    from services.sonar_client import call_sonar, sonar_available  # type: ignore

ASSETS_DIR = Path(__file__).resolve().parent / "assets"

SUPPORTED_TARGET_LANGS = {"ru"}

_LANG_NAMES = {"ru": "Russian"}

# ── Field allow-list ─────────────────────────────────────────────────────────
# Top-level scalar free-text fields that get translated.
TOP_LEVEL_TEXT_FIELDS = [
    "title",
    "genre",
    "comp_set_name",  # e.g. "Horror — 19 titles" -- only the label text
                        # translates; the embedded title COUNT is preserved
                        # by instructing Sonar to keep digits as-is (see
                        # prompt). Renderer only regexes for the FIRST
                        # digit run, so a translated count phrase still
                        # extracts correctly as long as digits survive.
    "description_100",
    "razor_20",
    "razor_10",
    "wedge",
    "wedge_support",
    "risks_wedge",
    "risks_wedge_support",
    "inner_definition",
    "ring2_definition",
]

# List-of-object fields: (list_key, [sub_fields_to_translate])
LIST_TEXT_FIELDS = [
    ("usps", ["title", "description", "proof", "strategy"]),
    ("reach", ["message"]),  # channel/kpi are short structured labels; see
                              # deny-list note below -- kept in EN by default
                              # to avoid corrupting CSV-like channel lists,
                              # but see ALSO_TRANSLATE_REACH_LABELS toggle.
    ("risks", ["proof", "mitigation"]),
]

# Optional secondary toggle: if the caller wants reach channel/kpi translated
# too, this can be flipped. Off by default per the spec's cautious allow-list
# (avoid corrupting comma-split "channels" parsing in render_reach.py).
ALSO_TRANSLATE_REACH_LABELS = False

# ── Field deny-list (documented for clarity; enforced implicitly by never
# reading these keys back from the Sonar response) ─────────────────────────
NEVER_TRANSLATE_FIELDS = [
    "release_date", "game_type", "inner", "platforms",
    "median_revenue_usd_millions", "avg_price_usd", "median_units_sold",
    "avg_hours_played",
    "cohorts",  # cohorts[].size is numeric; cohorts[].name IS translatable
                # free text, but is intentionally deferred (see NOTE below).
    "phases_override",
]

# NOTE on cohorts[].name: cohort names ("Prev Game Owners", "Genre Fans",
# etc.) are technically user-authored free text and a fuller localization
# would translate them. They are deferred from Phase 4.2's allow-list because
# render_sizing_circle.py and render_reach.py derive several DISPLAY strings
# (chart legend labels, "IP FANS (NO PRIOR)" etc.) from fixed `--inner`/`--type`
# enum choices rather than from `cohorts[].name` directly for the built-in
# presets (prev/dev/ip_fans/genre_fans/breakout) -- only the "other"/"custom"
# free-text override paths read cohorts[].name for display. Translating
# cohorts[].name without also localizing the enum-driven legend labels would
# produce a mixed-language slide. Full cohort-label localization is left as
# a follow-up (see gtm_revisions_summary.md Known Limitations).


class TranslationError(RuntimeError):
    """Raised when Sonar translation fails or returns an unusable response."""


def _collect_source_payload(inputs: dict[str, Any]) -> dict[str, Any]:
    """Extract only the allow-listed translatable strings from `inputs`."""
    payload: dict[str, Any] = {}
    for key in TOP_LEVEL_TEXT_FIELDS:
        val = inputs.get(key)
        if val:
            payload[key] = val

    for list_key, sub_fields in LIST_TEXT_FIELDS:
        items = inputs.get(list_key) or []
        translated_items = []
        for item in items:
            entry = {}
            for sf in sub_fields:
                v = item.get(sf)
                if v:
                    entry[sf] = v
            translated_items.append(entry)
        if translated_items:
            payload[list_key] = translated_items

    return payload


def _build_prompt(payload: dict[str, Any], target_lang: str) -> str:
    lang_name = _LANG_NAMES[target_lang]
    return (
        f"Translate ONLY the string values in the following JSON object to "
        f"{lang_name}. This is marketing copy for a video game go-to-market "
        f"slide deck.\n\n"
        f"STRICT RULES:\n"
        f"1. Return ONLY a single valid JSON object with the EXACT SAME "
        f"keys and structure as the input. Do not add, remove, or rename "
        f"any key.\n"
        f"2. Translate every string value naturally and idiomatically into "
        f"{lang_name} -- do not produce a literal word-for-word translation "
        f"if it reads awkwardly.\n"
        f"3. Preserve ALL digits, numbers, percentages, and punctuation "
        f"exactly where semantically equivalent (e.g. a count like '19' in "
        f"'Horror — 19 titles' must remain '19' in the translated string).\n"
        f"4. Do not translate proper nouns / brand names unless there is a "
        f"standard localized form.\n"
        f"5. Do not wrap the JSON in markdown code fences. Return raw JSON "
        f"only, no commentary before or after.\n\n"
        f"Input JSON:\n{json.dumps(payload, ensure_ascii=False, indent=2)}"
    )


def _extract_json(text: str) -> dict[str, Any]:
    """Parse Sonar's response text as JSON, tolerating markdown code fences."""
    t = text.strip()
    if t.startswith("```"):
        # Strip a leading ```json / ``` fence and a trailing ```
        t = t.split("\n", 1)[1] if "\n" in t else t[3:]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    t = t.strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError as e:
        raise TranslationError(
            f"Sonar response was not valid JSON after fence-stripping: {e}. "
            f"Raw (first 300 chars): {text[:300]!r}"
        ) from e


def _merge_translated(
    inputs: dict[str, Any], translated_payload: dict[str, Any]
) -> dict[str, Any]:
    """Return a NEW inputs dict: allow-listed fields overwritten with the
    translated values (falling back to the original on any missing/invalid
    key), every other field copied through unchanged.
    """
    out = json.loads(json.dumps(inputs))  # deep copy via round-trip

    for key in TOP_LEVEL_TEXT_FIELDS:
        if key in translated_payload and isinstance(translated_payload[key], str):
            out[key] = translated_payload[key]

    for list_key, sub_fields in LIST_TEXT_FIELDS:
        orig_items = inputs.get(list_key) or []
        trans_items = translated_payload.get(list_key) or []
        merged_items = []
        for i, orig_item in enumerate(orig_items):
            merged = dict(orig_item)
            if i < len(trans_items) and isinstance(trans_items[i], dict):
                for sf in sub_fields:
                    tv = trans_items[i].get(sf)
                    if isinstance(tv, str) and tv.strip():
                        merged[sf] = tv
            merged_items.append(merged)
        if merged_items:
            out[list_key] = merged_items

    return out


def translate_form_inputs(
    inputs: dict[str, Any], target_lang: str = "ru"
) -> dict[str, Any]:
    """Translate the free-text fields of a FormInputs-shaped dict.

    Args:
        inputs: dict matching main.py's FormInputs.model_dump() shape (or the
            renderer dict shape after `_form_inputs_to_render_dict` — both
            are supersets of the fields this function reads).
        target_lang: currently only "ru" is supported.

    Returns:
        A new dict, same shape as `inputs`, with allow-listed text fields
        translated and every other field passed through unchanged.

    Raises:
        ValueError: unsupported target_lang.
        TranslationError: Sonar is unavailable, or Sonar's response could
            not be parsed / used. Callers should treat this as a hard
            failure of the /translate endpoint (surface a 502/500), not a
            silent no-op — a deck saved with un-translated English text
            claiming language="ru" would be a correctness bug worse than
            failing loudly.
    """
    if target_lang not in SUPPORTED_TARGET_LANGS:
        raise ValueError(
            f"Unsupported target_lang {target_lang!r}; "
            f"supported: {sorted(SUPPORTED_TARGET_LANGS)}"
        )

    if not sonar_available():
        raise TranslationError(
            "Sonar is not available (no Perplexity API key configured — "
            "settings.perplexity_api_key is empty). Cannot translate "
            "form inputs without a live Sonar call. See "
            "gtm_revisions_summary.md Known Limitations."
        )

    payload = _collect_source_payload(inputs)
    if not payload:
        # Nothing to translate (shouldn't normally happen -- title/genre are
        # required fields) -- return inputs unchanged rather than making a
        # pointless Sonar call.
        logger.warning("translate_form_inputs: no translatable fields found in inputs")
        return json.loads(json.dumps(inputs))

    prompt = _build_prompt(payload, target_lang)

    try:
        response = call_sonar(
            prompt,
            system=(
                "You are a professional game-marketing localization "
                "translator. You output ONLY raw JSON, matching the exact "
                "structure requested, with no commentary, no markdown "
                "fences, and no explanations."
            ),
            max_tokens=2000,
            temperature=0.2,
            search_context_size="low",
        )
    except RuntimeError as e:
        raise TranslationError(f"Sonar call failed: {e}") from e

    translated_payload = _extract_json(response.text)
    return _merge_translated(inputs, translated_payload)


def load_ru_roadmap_phases() -> dict[str, Any]:
    """Load the pre-translated Russian roadmap phases asset.

    Used as the `phases_override` argument to
    `gtm_pack.render_roadmap()` / `render_full_pack(..., language="ru")`
    callers, NOT consumed by `translate_form_inputs` itself. Kept here so
    callers (main.py's /translate endpoint) have one place to import both
    the per-deck Sonar translation AND the static roadmap fallback from.
    """
    path = ASSETS_DIR / "roadmap_phases_ru.json"
    with open(path, encoding="utf-8") as f:
        return json.load(f)


__all__ = [
    "translate_form_inputs",
    "load_ru_roadmap_phases",
    "TranslationError",
    "SUPPORTED_TARGET_LANGS",
    "TOP_LEVEL_TEXT_FIELDS",
    "LIST_TEXT_FIELDS",
    "NEVER_TRANSLATE_FIELDS",
]
