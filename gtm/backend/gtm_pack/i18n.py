"""Phase 4 (Russian localization) layout-adjustment helpers.

BACKEND-MIRROR ONLY. This module lives under sentimentpulse/gtm/backend/gtm_pack/
and is intentionally NOT copied into skills/user/gtm-slide-pack-kickoff/scripts/ —
that divergence is deliberate (see gtm_revisions_summary.md "Phase 4" section
and the GTM Phase 3+4 task brief: "language kwarg ... backend mirror only").

Design constraints (locked, do not change without updating all 7 renderers):
  - No display-font swap. Trebuchet MS Bold / Calibri stay the SAME fonts for
    Russian — Cyrillic glyphs are present in both on all common platforms.
  - No palette changes. Only text sizing / padding / wrap allowances differ.
  - Body copy renders ~1pt smaller in Russian (10pt -> 9pt, etc.) because
    Cyrillic strings from a literal translation tend to run longer than the
    English source for the same meaning.
  - Card/box internal padding is scaled by ~0.8x for the same reason.
  - Callers that wrap text to a fixed number of lines should allow one extra
    line for Russian (e.g. a 1-line English label may need 2 lines in
    Russian) rather than truncating or overflowing the shape.
"""

from __future__ import annotations

CYRILLIC_LANGUAGES = {"ru"}


def is_cyrillic(language: str | None) -> bool:
    return (language or "en") in CYRILLIC_LANGUAGES


def body_pt(language: str | None, base: float) -> float:
    """Scale a body-text point size down by 1pt for Cyrillic, floor 7pt."""
    if not is_cyrillic(language):
        return base
    return max(base - 1, 7)


def title_pt(language: str | None, base: float) -> float:
    """Titles/display text keep size (display font unaffected) but we still
    trim slightly for very long Cyrillic titles to reduce collision risk."""
    if not is_cyrillic(language):
        return base
    return max(base - 1, 12)


def pad_scale(language: str | None) -> float:
    """Multiplier applied to fixed inch padding/margin constants inside cards."""
    return 0.8 if is_cyrillic(language) else 1.0


def extra_wrap_lines(language: str | None) -> int:
    """Extra line-wrap allowance for fixed-height text boxes."""
    return 1 if is_cyrillic(language) else 0
