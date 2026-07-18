"""Shared helper: auto-shrink long slide titles to keep them on one line.

Added in v7.1 (2026-07-18) after the user reported that on multiple slides
the title was wrapping onto a second line and overwriting the subtitle copy
below it. Rather than doing dynamic layout with wrap detection (fragile
with python-pptx text metrics), we shrink the title font size in 2pt steps
until the text fits on ONE line at the given width, down to a hard floor.

The floor (default 22pt) is chosen so titles still read as headlines and
stay visually dominant vs. the 13-14pt subtitle.

Empirically calibrated against Trebuchet MS Bold rendered by python-pptx.
"""


def wrap_label(text: str, max_chars_per_line: int, max_lines: int = 2) -> str:
    """Word-wrap ``text`` into up to ``max_lines`` lines of at most
    ``max_chars_per_line`` characters each. Joined with newlines. If the
    text still doesn't fit even after using all lines, the final line is
    truncated with an ellipsis. Used for in-circle cohort labels on the
    Sizing Rings slide so we can preserve the user's full cohort name
    across two lines instead of mid-word truncation like 'FANS OF HELLRA'.
    """
    if not text:
        return text
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        candidate = f"{cur} {w}".strip()
        if len(candidate) <= max_chars_per_line:
            cur = candidate
            continue
        # word doesn't fit on current line -- push cur, start a new line
        if cur:
            lines.append(cur)
        if len(lines) >= max_lines:
            # out of lines; append current word to the LAST line with ellipsis
            last = lines[-1]
            remaining = max_chars_per_line - len(last) - 1
            if remaining > 3:
                lines[-1] = f"{last} {w[:remaining-1]}\u2026"
            else:
                lines[-1] = f"{last[:max_chars_per_line-1]}\u2026"
            return "\n".join(lines)
        cur = w if len(w) <= max_chars_per_line else w[:max_chars_per_line-1] + "\u2026"
    if cur:
        lines.append(cur)
    return "\n".join(lines[:max_lines])


def fit_title_pt(text: str, width_in: float, base_pt: int = 34, min_pt: int = 22) -> int:
    """Return a Trebuchet MS Bold font size (pt) that keeps `text` on ONE
    line within `width_in` inches. Shrinks from `base_pt` down toward
    `min_pt` in 2pt steps."""
    if not text:
        return base_pt
    n = len(text)
    pt = base_pt
    while pt >= min_pt:
        # Trebuchet Bold at N pt averages ~0.036*N inches per character.
        # 6% safety margin for kerning + slight header padding.
        if n * 0.036 * pt <= width_in * 0.94:
            return pt
        pt -= 2
    return min_pt
