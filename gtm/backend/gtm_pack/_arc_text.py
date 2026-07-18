"""Arc text renderer for the Sizing Rings slide.

python-pptx has no native arc-text primitive, so this module lays out a
string glyph-by-glyph along a circular arc, rotating each glyph so its
baseline is tangent to the arc -- the classic "coin / stamp / badge"
treatment (text hugging the inside of a ring, letters fanning out around
the curve). The result is a fully-editable PPTX (each glyph is a tiny
textbox), not an image overlay -- so themes still apply and the deck
stays editable in PowerPoint if the user wants to tweak.

Geometry / style (v8, badge-stamp pass)
----------------------------------------
Modeled directly on the classic circular-stamp reference: a ring with a
label curving along the TOP half and, if needed, a second label curving
along the BOTTOM half, with small dot separators at 9 o'clock and
3 o'clock between them.

  - TOP arc: text centered at theta=0 (12 o'clock). Letters are set so
    their tops point AWAY from the ring's center (outward) -- reading
    left-to-right along the top of the curve, upright.
  - BOTTOM arc: text centered at theta=180 (6 o'clock). Letters are
    ALSO set so their tops point away from center -- reading
    left-to-right along the bottom of the curve. This is the
    ``flip_for_bottom`` path: mirror image of the top-arc placement,
    achieved by reversing glyph order and adding 180 degrees of
    rotation, so the text is never upside down.
  - Each glyph's rotation exactly equals its own angular position on the
    arc (plus 180 on the bottom), so the glyph's local "up" points
    radially outward at every point along the curve -- true tangency,
    matching the reference image.

Calibration
-----------
Character advance is estimated as ``CHAR_ADVANCE_IN_PER_PT * font_pt``
inches per glyph (space included). Empirically measured against actual
LibreOffice/pptx rendering of Calibri Bold uppercase strings at several
sizes (8-12pt): raw measured advance ranged ~0.0063-0.0076 in/pt across
different strings, averaging ~0.0072 in/pt. We use 0.0074 in/pt (a
touch above the mean) as a deliberate small safety margin so
auto-shrink is slightly conservative -- glyphs end up a hair closer
together rather than overflowing the intended arc span.

Coordinate convention
---------------------
All positions and radii are in INCHES. The slide's PPTX coordinate system
has +x to the right and +y DOWN (standard PPTX). Angles are measured with
0 = top, increasing clockwise. So a label above the ring uses theta ~= 0
and a label below the ring uses theta ~= 180.
"""

from __future__ import annotations

import math

from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt


# Calibri Bold uppercase: glyph advance width in inches per pt of font size.
# Calibrated against actual rendered PNG output (measured bounding-box width
# of several test strings at 8/10/12pt); see module docstring.
CHAR_ADVANCE_IN_PER_PT = 0.0074


def _polar_to_xy(cx: float, cy: float, r: float, theta_deg: float) -> tuple[float, float]:
    """Convert polar (radius, angle-from-12-o'clock-clockwise) to (x,y) inches.

    Angle convention: 0 = up (12 o'clock), 90 = right (3 o'clock),
    180 = down (6 o'clock), 270 = left (9 o'clock). PPTX +y is downward,
    so we FLIP sin's sign in the y calculation.
    """
    a = math.radians(theta_deg)
    x = cx + r * math.sin(a)
    y = cy - r * math.cos(a)
    return x, y


def fit_arc_text_pt(text: str, radius_in: float, max_span_deg: float,
                    base_pt: int = 11, min_pt: int = 6) -> int:
    """Return the largest font size (pt) such that ``text`` fits within
    ``max_span_deg`` when laid out on an arc of ``radius_in`` inches.

    Assumes Calibri Bold uppercase; margin baked in.
    """
    if not text:
        return base_pt
    n = len(text)
    max_arc_in = math.radians(max_span_deg) * radius_in * 0.94  # 6% safety
    pt = base_pt
    while pt >= min_pt:
        text_width_in = n * CHAR_ADVANCE_IN_PER_PT * pt
        if text_width_in <= max_arc_in:
            return pt
        pt -= 1
    return min_pt


def arc_span_deg(text: str, radius_in: float, pt: float) -> float:
    """Degrees of arc that ``text`` occupies at font size ``pt`` on a ring
    of ``radius_in`` inches."""
    n = len(text)
    text_width_in = n * CHAR_ADVANCE_IN_PER_PT * pt
    return math.degrees(text_width_in / radius_in)


def _place_arc_run(slide, cx: float, cy: float, radius_in: float, text: str,
                    *, theta_mid_deg: float, font: str, pt: float, bold: bool,
                    color: RGBColor | None, is_bottom: bool,
                    letter_spacing_deg_extra: float = 0.0):
    """Place one arc run (already sized) of glyphs centered on theta_mid_deg.

    On the top half (``is_bottom=False``) glyphs are read left-to-right in
    natural order, rotation = own angle (tops point outward/away from
    center, which for the top half means "upright").

    On the bottom half (``is_bottom=True``) glyphs are reversed in render
    order and rotated +180 so that, walking left-to-right along the
    bottom of the ring, the text still reads correctly with letter-tops
    pointing outward (away from center, i.e. downward) -- the standard
    badge/coin mirrored-bottom treatment.
    """
    if not text:
        return
    n = len(text)
    text_width_in = n * CHAR_ADVANCE_IN_PER_PT * pt
    total_span_deg = math.degrees(text_width_in / radius_in) + letter_spacing_deg_extra * max(0, n - 1)

    if is_bottom:
        glyph_order = list(reversed(text))
        base_rotation_deg = 180.0
    else:
        glyph_order = list(text)
        base_rotation_deg = 0.0

    if n == 1:
        glyph_angles = [theta_mid_deg]
    else:
        step = total_span_deg / n
        first = theta_mid_deg - (total_span_deg / 2.0) + (step / 2.0)
        glyph_angles = [first + i * step for i in range(n)]

    glyph_side_in = pt * 1.55 / 72.0  # ample padding, square glyph box

    for glyph, ang in zip(glyph_order, glyph_angles):
        if glyph == " ":
            continue
        gx, gy = _polar_to_xy(cx, cy, radius_in, ang)
        tlx = gx - glyph_side_in / 2.0
        tly = gy - glyph_side_in / 2.0
        box = slide.shapes.add_textbox(
            Inches(tlx), Inches(tly), Inches(glyph_side_in), Inches(glyph_side_in)
        )
        tf = box.text_frame
        tf.margin_left = tf.margin_right = Emu(0)
        tf.margin_top = tf.margin_bottom = Emu(0)
        tf.word_wrap = False
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        r = p.add_run()
        r.text = glyph
        r.font.name = font
        r.font.size = Pt(pt)
        r.font.bold = bold
        if color is not None:
            r.font.color.rgb = color
        # Rotation: the glyph's own angular position IS its tangent
        # rotation (0 = upright at 12 o'clock, 90 = rotated 90cw at
        # 3 o'clock, etc). On the bottom arc we add 180 so letters read
        # right-side-up (tops pointing outward/down) rather than upside
        # down.
        rotation_deg = (ang + base_rotation_deg) % 360
        box.rotation = rotation_deg


def add_arc_text(slide, cx: float, cy: float, radius_in: float, text: str,
                 *, theta_mid_deg: float = 0.0, font: str = "Calibri",
                 size: int = 11, bold: bool = True,
                 color: RGBColor | None = None,
                 max_span_deg: float = 160.0,
                 min_pt: int = 6,
                 flip_for_bottom: bool = True):
    """Lay out ``text`` along an arc centered on (cx, cy), stamp/badge style.

    - ``radius_in``: arc radius, in inches -- the visual "text baseline"
      distance from the ring center.
    - ``text``: string to render, uppercase in/out.
    - ``theta_mid_deg``: midpoint of the arc where text is centered. 0 = top,
      180 = bottom.
    - ``max_span_deg``: maximum arc span the text may consume. Font auto-
      shrinks down to ``min_pt`` to fit.
    - ``flip_for_bottom``: when True and the arc midpoint sits on the
      bottom half (90 < theta_mid < 270), the text is placed using the
      mirrored bottom-arc treatment so it reads upright rather than
      upside down.

    Returns the font size actually used.
    """
    if not text:
        return size

    pt = fit_arc_text_pt(text, radius_in, max_span_deg, base_pt=size, min_pt=min_pt)

    theta_norm = theta_mid_deg % 360
    is_bottom = flip_for_bottom and (90 < theta_norm < 270)

    _place_arc_run(slide, cx, cy, radius_in, text, theta_mid_deg=theta_mid_deg,
                   font=font, pt=pt, bold=bold, color=color, is_bottom=is_bottom)
    return pt


def add_arc_text_split(slide, cx: float, cy: float, radius_in: float, text: str,
                        *, font: str = "Calibri", size: int = 11, bold: bool = True,
                        color: RGBColor | None = None,
                        max_span_deg: float = 200.0, min_pt: int = 6,
                        dot_color: RGBColor | None = None):
    """Badge-stamp layout: try to fit ``text`` on a single TOP arc first.

    If it doesn't fit within ``max_span_deg`` even at ``min_pt``, split the
    words across a TOP arc (theta_mid=0) and a BOTTOM arc (theta_mid=180),
    each spanning up to ~190 degrees, with small dot separators placed at
    9 o'clock (270) and 3 o'clock (90) -- matching the classic circular
    stamp reference where a long label wraps fully around the ring.

    Returns the font size actually used.
    """
    if not text:
        return size

    n = len(text)
    # Try a single top arc first, at the largest size that still respects
    # min_pt AND keeps total span under max_span_deg.
    single_pt = fit_arc_text_pt(text, radius_in, max_span_deg, base_pt=size, min_pt=min_pt)
    single_span = arc_span_deg(text, radius_in, single_pt)
    if single_span <= max_span_deg or single_pt <= min_pt and single_span <= max_span_deg + 1:
        # Fits on one line around the top -- classic case for short/medium labels.
        if single_span <= max_span_deg:
            add_arc_text(slide, cx, cy, radius_in, text, theta_mid_deg=0.0,
                         font=font, size=size, bold=bold, color=color,
                         max_span_deg=max_span_deg, min_pt=min_pt)
            return single_pt

    # Doesn't fit on a single top arc even at min_pt -- split into two
    # words-balanced halves: top arc + bottom arc, dot separators at the sides.
    words = text.split()
    best_split = len(words) // 2 or 1
    # Choose split point that balances character length between halves.
    if len(words) > 1:
        cum = 0
        total = sum(len(w) for w in words) + (len(words) - 1)
        running = 0
        best_diff = None
        for i in range(1, len(words)):
            running = sum(len(w) for w in words[:i]) + (i - 1)
            diff = abs(running - (total - running))
            if best_diff is None or diff < best_diff:
                best_diff = diff
                best_split = i
    top_words = words[:best_split] if len(words) > 1 else words
    bottom_words = words[best_split:] if len(words) > 1 else []
    top_text = " ".join(top_words)
    bottom_text = " ".join(bottom_words)

    half_span = max_span_deg * 0.92  # leave room for dot separators at the sides
    top_pt = fit_arc_text_pt(top_text, radius_in, half_span, base_pt=size, min_pt=min_pt)
    bottom_pt = fit_arc_text_pt(bottom_text, radius_in, half_span, base_pt=size, min_pt=min_pt) if bottom_text else top_pt
    used_pt = min(top_pt, bottom_pt)

    _place_arc_run(slide, cx, cy, radius_in, top_text, theta_mid_deg=0.0,
                   font=font, pt=used_pt, bold=bold, color=color, is_bottom=False)
    if bottom_text:
        _place_arc_run(slide, cx, cy, radius_in, bottom_text, theta_mid_deg=180.0,
                       font=font, pt=used_pt, bold=bold, color=color, is_bottom=True)

    # Dot separators at 9 o'clock and 3 o'clock, matching the reference badge.
    if bottom_text:
        dc = dot_color if dot_color is not None else color
        _add_dot(slide, cx, cy, radius_in, 90.0, dc)
        _add_dot(slide, cx, cy, radius_in, 270.0, dc)

    return used_pt


def _add_dot(slide, cx: float, cy: float, radius_in: float, theta_deg: float,
             color: RGBColor | None):
    """Small round separator dot on the arc at the given angle."""
    from pptx.enum.shapes import MSO_SHAPE
    dot_d = 0.045
    gx, gy = _polar_to_xy(cx, cy, radius_in, theta_deg)
    s = slide.shapes.add_shape(
        MSO_SHAPE.OVAL, Inches(gx - dot_d / 2), Inches(gy - dot_d / 2),
        Inches(dot_d), Inches(dot_d),
    )
    s.fill.solid()
    s.fill.fore_color.rgb = color if color is not None else RGBColor(0, 0, 0)
    s.line.fill.background()
    s.shadow.inherit = False
    s.text_frame.text = ""


def fit_inner_circle_pt(text: str, diameter_in: float,
                        base_pt: int = 16, min_pt: int = 6,
                        max_lines: int = 2) -> tuple[int, list[str]]:
    """Return (font_pt, lines) that fit ``text`` inside a circle of
    ``diameter_in`` inches. Wraps to at most ``max_lines`` lines. The chord
    length across the circle at 2/3 of the way down (where the last text
    line sits) is used as the effective usable width so we don't push
    letters outside the circle's curved edge.

    Uses Calibri Bold uppercase glyph metrics (~0.5 * pt per char in
    inches / pt calibration).
    """
    if not text:
        return base_pt, []
    CALIBRI_BOLD_UPPER = 0.5 / 72.0  # in per pt
    r = diameter_in / 2.0
    # Usable width for a wrapped line: chord at |y| = r * 0.55 (mid-band above/
    # below center). chord = 2 * sqrt(r^2 - y^2)
    y_off = r * 0.55
    usable_w_in = 2.0 * math.sqrt(max(0.0, r * r - y_off * y_off)) * 0.9  # 10% margin
    pt = base_pt
    while pt >= min_pt:
        # Try wrapping to at most max_lines lines given this width
        max_chars_per_line = int(usable_w_in / (CALIBRI_BOLD_UPPER * pt))
        if max_chars_per_line < 1:
            pt -= 1
            continue
        lines = _wrap_words(text, max_chars_per_line, max_lines)
        if lines is not None:
            return pt, lines
        pt -= 1
    # Give up: just take first N chars per line
    max_chars_per_line = max(3, int(usable_w_in / (CALIBRI_BOLD_UPPER * min_pt)))
    return min_pt, [text[:max_chars_per_line]]


def _wrap_words(text: str, max_chars_per_line: int, max_lines: int) -> list[str] | None:
    """Greedy word wrap. Returns None if any single word is longer than
    max_chars_per_line, or if the wrapped output exceeds max_lines."""
    words = text.split()
    if not words:
        return []
    for w in words:
        if len(w) > max_chars_per_line:
            return None
    lines: list[str] = []
    cur = ""
    for w in words:
        cand = f"{cur} {w}".strip()
        if len(cand) <= max_chars_per_line:
            cur = cand
        else:
            lines.append(cur)
            if len(lines) >= max_lines:
                return None
            cur = w
    if cur:
        lines.append(cur)
    return lines if len(lines) <= max_lines else None
