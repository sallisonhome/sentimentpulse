#!/usr/bin/env python3
"""Render the GTM Slide Pack Step 1 'Target Audiences & Sizing' nested-circle slide.

Two themes baked in:
  - dark   (V2 Modern Mono)  : dark slide, teal ramp + warm gold accent on breakout tier, KPI cards
  - light  (V4 Bold Brand)   : light slide, refined original palette, color-swatch legend rows

v7 polish pass (2026-07-18): every ring is now filled with its tier color and
carries its own name + formatted count directly inside (or, for the outer
ring where the band is too thin, just outside the ring on a matching-color
chip) with a contrast-aware foreground color. The side KPI/legend card is
KEPT next to the chart. Subtitle now explicitly calls out "Potential Buyers"
so the numbers are self-explanatory. Footer removed (global v7 rule).

Outputs both a PPTX and a PNG to --out-dir.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import tempfile

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

try:
    from .i18n import body_pt  # package-relative (used via gtm_pack/__init__.py wrapper)
except ImportError:  # pragma: no cover - direct-script invocation fallback
    from i18n import body_pt


# ---------- helpers ----------
def hex_rgb(h: str) -> RGBColor:
    h = h.lstrip("#")
    return RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def relative_luminance(h: str) -> float:
    """Approximate relative luminance (0=black, 1=white) for contrast picks."""
    h = h.lstrip("#")
    r, g, b = int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def fg_for_bg(hex_bg: str, light_fg: str, dark_fg: str) -> RGBColor:
    """Pick light_fg or dark_fg (hex strings) based on background luminance."""
    return hex_rgb(light_fg) if relative_luminance(hex_bg) < 0.55 else hex_rgb(dark_fg)


def slugify(value: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "_", value.strip().lower()).strip("_")
    return s or "untitled"


def fmt_num(n: int) -> str:
    return f"{n:,}"


def fmt_short(n: int) -> str:
    """Format a number compactly for in-circle labels (1.2M, 850K, 12.3M)."""
    if n >= 1_000_000:
        v = n / 1_000_000
        return f"{v:.1f}M" if v < 10 else f"{int(round(v))}M"
    if n >= 1_000:
        v = n / 1_000
        return f"{int(round(v))}K"
    return f"{n:,}"


# ---------- shape primitives ----------
def add_rect(slide, x, y, w, h, fill, line=None):
    s = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    s.fill.solid()
    s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line
    s.shadow.inherit = False
    s.text_frame.text = ""
    return s


def add_circle(slide, cx, cy, d, fill, line=None, line_w_pt=2.0):
    s = slide.shapes.add_shape(
        MSO_SHAPE.OVAL, Inches(cx - d / 2), Inches(cy - d / 2), Inches(d), Inches(d)
    )
    s.fill.solid()
    s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line
        s.line.width = Pt(line_w_pt)
    s.shadow.inherit = False
    s.text_frame.text = ""
    return s


def add_text(slide, x, y, w, h, text, *, font="Calibri", size=12, bold=False,
             color=None, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, italic=False,
             line_spacing=None):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.margin_left = tf.margin_right = Emu(0)
    tf.margin_top = tf.margin_bottom = Emu(0)
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    if isinstance(text, str):
        text = [text]
    for i, line in enumerate(text):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        if line_spacing is not None:
            p.line_spacing = line_spacing
        r = p.add_run()
        r.text = line
        r.font.name = font
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.italic = italic
        if color is not None:
            r.font.color.rgb = color
    return box


# ---------- Cohort framing ----------
def innermost_label(args) -> tuple[str, str]:
    """Return (chart_label, legend_label) for the innermost cohort."""
    if args.inner == "prev":
        return ("Prev owners", "Prev Game Owners")
    if args.inner == "dev":
        return ("Dev fans", "Developer Fans")
    # custom
    name = args.inner_name or "Cohort"
    return (name, name)


def ring2_chart_label(args) -> str:
    if args.type == "custom":
        return args.ring2_name or "Custom cohort"
    return "IP Fans"


def ring2_legend_name(args) -> str:
    if args.type == "custom":
        return args.ring2_name
    return "IP Fans (no prior)"


def ring2_legend_desc(args) -> str:
    if args.type == "custom":
        return args.ring2_definition or ""
    return "Followers of the IP who didn't own previous"


def cohort3_name(args) -> str:
    """User-typed name for ring 3 (was hardcoded 'Genre Fans'). Falls back
    to the 'Genre Fans' default ONLY when no user-typed name was supplied --
    the wizard's Step 3 always collects a name for this cohort, so this
    fallback should rarely trigger in practice."""
    return getattr(args, "cohort3_name", None) or "Genre Fans"


def cohort3_desc(args) -> str:
    return getattr(args, "cohort3_definition", None) or f"Top 5 avg in {args.genre}"


def cohort4_name(args) -> str:
    """User-typed name for the outer ring (was hardcoded 'Breakout Ceiling')."""
    return getattr(args, "cohort4_name", None) or "Breakout Ceiling"


def cohort4_desc(args) -> str:
    return getattr(args, "cohort4_definition", None) or f"Top 2 ever in {args.genre}+"


# ============================================================
# THEME: DARK  (V2 Modern Mono)
# ============================================================
def render_dark(args, out_path):
    L = getattr(args, "language", "en")
    BG       = hex_rgb("#0E1116")
    SURFACE  = hex_rgb("#161A21")
    BORDER   = hex_rgb("#1F2530")
    INK      = hex_rgb("#E8E6E1")
    MUTED    = hex_rgb("#8A8F99")
    A1       = hex_rgb("#0A2A30")  # outer
    A2       = hex_rgb("#155966")
    A3       = hex_rgb("#2FA9BD")
    A4       = hex_rgb("#7FD8E3")  # inner
    ACCENT   = hex_rgb("#FFB454")  # warm gold — used on breakout

    A1_HEX, A2_HEX, A3_HEX, A4_HEX = "#0A2A30", "#155966", "#2FA9BD", "#7FD8E3"

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    # Background + top accent bar
    add_rect(slide, 0, 0, 13.333, 7.5, BG)
    add_rect(slide, 0, 0, 13.333, 0.08, ACCENT)

    # Title block
    add_text(slide, 0.6, 0.4, 8, 0.3, "TARGET AUDIENCES & SIZING",
             font="Trebuchet MS", size=10, bold=True, color=ACCENT)
    add_text(slide, 0.6, 0.75, 11, 0.85, args.title,
             font="Trebuchet MS", size=34, bold=True, color=INK)
    type_label = {"sequel": "Sequel", "new_ip_with_fans": "IP-based",
                  "custom": "Original IP"}[args.type]
    add_text(slide, 0.6, 1.55, 11.5, 0.4,
             f"Potential buyer audience by tier · {args.genre}  ·  {type_label}",
             font="Calibri", size=body_pt(L, 13), color=MUTED)

    # ---- Circles (left half) — filled, labeled tiers ----
    cx, cy = 3.55, 4.75
    d1, d2, d3, d4 = 5.2, 3.95, 2.65, 1.35  # outer -> inner diameters
    add_circle(slide, cx, cy, d1, A1, line=BORDER, line_w_pt=0.75)
    add_circle(slide, cx, cy, d2, A2, line=BORDER, line_w_pt=0.75)
    add_circle(slide, cx, cy, d3, A3, line=BORDER, line_w_pt=0.75)
    add_circle(slide, cx, cy, d4, A4, line=BORDER, line_w_pt=0.75)

    inner_chart = ring2_chart_label(args)
    prev_chart, _ = innermost_label(args)

    fg1 = fg_for_bg(A1_HEX, "#E8E6E1", "#0E1116")
    fg2 = fg_for_bg(A2_HEX, "#E8E6E1", "#0E1116")
    fg3 = fg_for_bg(A3_HEX, "#E8E6E1", "#0E1116")
    fg4 = fg_for_bg(A4_HEX, "#E8E6E1", "#0E1116")

    # Ring band radii (top edge to next ring's top edge) used to position each
    # ring's label vertically within its own visible band, offset upward from
    # circle center so text sits inside the band rather than centered on the
    # whole nested stack.
    r1, r2, r3, r4 = d1 / 2, d2 / 2, d3 / 2, d4 / 2
    band1_y = cy - (r1 + r2) / 2   # ring 1 (outer) band midpoint, above ring2
    band2_y = cy - (r2 + r3) / 2   # ring 2 band midpoint
    band3_y = cy - (r3 + r4) / 2   # ring 3 band midpoint

    # Outer ring (cohort 4 / breakout ceiling) — label above the top of ring
    # 2, inside ring 1's band. Uses the user-typed cohort name verbatim
    # (truncated only if it doesn't fit the band width).
    c4_label = cohort4_name(args)
    add_text(slide, cx - 1.7, band1_y - 0.28, 3.4, 0.3, c4_label.upper()[:26],
             font="Calibri", size=body_pt(L, 9), bold=True, color=fg1,
             align=PP_ALIGN.CENTER)
    add_text(slide, cx - 1.7, band1_y + 0.0, 3.4, 0.4, fmt_short(args.breakout),
             font="Trebuchet MS", size=20, bold=True, color=fg1,
             align=PP_ALIGN.CENTER)

    # Ring 2 (cohort 3 / "genre fans" slot) band — user-typed name verbatim.
    c3_label = cohort3_name(args)
    add_text(slide, cx - 1.3, band2_y - 0.26, 2.6, 0.28, c3_label.upper()[:20],
             font="Calibri", size=body_pt(L, 8), bold=True, color=fg2,
             align=PP_ALIGN.CENTER)
    add_text(slide, cx - 1.3, band2_y + 0.0, 2.6, 0.36, fmt_short(args.genre_fans),
             font="Trebuchet MS", size=18, bold=True, color=fg2,
             align=PP_ALIGN.CENTER)

    # Ring 3 (ip fans / custom ring2) band
    add_text(slide, cx - 1.0, band3_y - 0.24, 2.0, 0.26, inner_chart.upper()[:18],
             font="Calibri", size=body_pt(L, 7.5), bold=True, color=fg3,
             align=PP_ALIGN.CENTER)
    add_text(slide, cx - 1.0, band3_y + 0.0, 2.0, 0.32, fmt_short(args.ip_fans),
             font="Trebuchet MS", size=15, bold=True, color=fg3,
             align=PP_ALIGN.CENTER)

    # Innermost — short number + label, centered in the small inner circle
    add_text(slide, cx - 0.62, cy - 0.30, 1.24, 0.36, fmt_short(args.prev),
             font="Trebuchet MS", size=15, bold=True, color=fg4,
             align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    add_text(slide, cx - 0.62, cy + 0.06, 1.24, 0.26, prev_chart.upper()[:14],
             font="Calibri", size=body_pt(L, 6.5), bold=True, color=fg4,
             align=PP_ALIGN.CENTER)

    # ---- KPI cards (right half) — kept, per user's "keep side card" pick ----
    _, inner_legend = innermost_label(args)
    inner_desc = "Players of the prior title" if args.inner == "prev" else \
                 "Direct followers of the developer" if args.inner == "dev" else \
                 (args.inner_definition or "")

    cards = [
        (inner_legend.upper(),               fmt_num(args.prev),       inner_desc,                              A4),
        (ring2_legend_name(args).upper(),    fmt_num(args.ip_fans),    ring2_legend_desc(args),                 A3),
        (cohort3_name(args).upper(),          fmt_num(args.genre_fans), cohort3_desc(args),                      A2),
        (cohort4_name(args).upper(),          fmt_num(args.breakout),   cohort4_desc(args),                      ACCENT),
    ]
    rx = 7.5
    ry = 2.15
    cw = 5.25
    ch = 1.08
    gap = 0.14
    add_text(slide, rx, ry - 0.32, cw, 0.28, "POTENTIAL BUYERS BY TIER",
             font="Calibri", size=body_pt(L, 9), bold=True, color=MUTED)
    for i, (label, num, desc, accent) in enumerate(cards):
        y = ry + i * (ch + gap)
        add_rect(slide, rx, y, cw, ch, SURFACE)
        # Tier accent strip — left side, indicates which ring this row maps to
        add_rect(slide, rx, y, 0.06, ch, accent)
        add_text(slide, rx + 0.3, y + 0.11, cw - 0.5, 0.28, label,
                 font="Calibri", size=body_pt(L, 9), bold=True, color=MUTED)
        add_text(slide, rx + 0.3, y + 0.38, cw - 0.5, 0.42, num,
                 font="Trebuchet MS", size=20, bold=True, color=INK)
        add_text(slide, rx + 0.3, y + 0.78, cw - 0.5, 0.25, desc,
                 font="Calibri", size=body_pt(L, 9.5), color=MUTED)

    prs.save(out_path)


# ============================================================
# THEME: LIGHT (V4 Bold Brand)
# ============================================================
def render_light(args, out_path):
    L = getattr(args, "language", "en")
    BG       = hex_rgb("#FFFFFF")
    INK      = hex_rgb("#1A1A1A")
    MUTED    = hex_rgb("#5C5C5C")
    HAIR     = hex_rgb("#E8E8E8")
    # Refined palette — same hue family as user's original template
    C1       = hex_rgb("#E5A700")  # gold (outer)
    C2       = hex_rgb("#D63A57")  # rose
    C3       = hex_rgb("#1F9B8E")  # teal
    C4       = hex_rgb("#7DD4C9")  # mint (inner)

    C1_HEX, C2_HEX, C3_HEX, C4_HEX = "#E5A700", "#D63A57", "#1F9B8E", "#7DD4C9"

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    add_rect(slide, 0, 0, 13.333, 7.5, BG)

    # Left accent stripe
    add_rect(slide, 0, 0, 0.25, 7.5, C3)

    # Title block
    add_text(slide, 0.7, 0.5, 11, 0.3, "TARGET AUDIENCES",
             font="Calibri", size=body_pt(L, 10), bold=True, color=C3)
    add_text(slide, 0.7, 0.85, 11, 0.8, args.title,
             font="Trebuchet MS", size=34, bold=True, color=INK)
    type_label = {"sequel": "Sequel", "new_ip_with_fans": "IP-based",
                  "custom": "Original IP"}[args.type]
    add_text(slide, 0.7, 1.65, 11.3, 0.4,
             f"Potential buyer audience by tier · {args.genre} · {type_label}",
             font="Calibri", size=14, color=MUTED)

    # ---- Circles (left half) — filled, labeled tiers ----
    cx, cy = 3.75, 4.85
    d1, d2, d3, d4 = 5.3, 4.05, 2.75, 1.5
    add_circle(slide, cx, cy, d1, C1, line=BG, line_w_pt=2.5)
    add_circle(slide, cx, cy, d2, C2, line=BG, line_w_pt=2.5)
    add_circle(slide, cx, cy, d3, C3, line=BG, line_w_pt=2.5)
    add_circle(slide, cx, cy, d4, C4, line=BG, line_w_pt=2.5)

    inner_chart = ring2_chart_label(args)
    prev_chart, _ = innermost_label(args)

    fg1 = fg_for_bg(C1_HEX, "#FFFFFF", "#1A1A1A")
    fg2 = fg_for_bg(C2_HEX, "#FFFFFF", "#1A1A1A")
    fg3 = fg_for_bg(C3_HEX, "#FFFFFF", "#1A1A1A")
    fg4 = fg_for_bg(C4_HEX, "#FFFFFF", "#1A1A1A")

    r1, r2, r3, r4 = d1 / 2, d2 / 2, d3 / 2, d4 / 2
    band1_y = cy - (r1 + r2) / 2
    band2_y = cy - (r2 + r3) / 2
    band3_y = cy - (r3 + r4) / 2

    c4_label = cohort4_name(args)
    add_text(slide, cx - 1.75, band1_y - 0.28, 3.5, 0.3, c4_label.upper()[:26],
             font="Calibri", size=body_pt(L, 9), bold=True, color=fg1,
             align=PP_ALIGN.CENTER)
    add_text(slide, cx - 1.75, band1_y + 0.0, 3.5, 0.4, fmt_short(args.breakout),
             font="Trebuchet MS", size=20, bold=True, color=fg1,
             align=PP_ALIGN.CENTER)

    c3_label = cohort3_name(args)
    add_text(slide, cx - 1.35, band2_y - 0.26, 2.7, 0.28, c3_label.upper()[:20],
             font="Calibri", size=body_pt(L, 8), bold=True, color=fg2,
             align=PP_ALIGN.CENTER)
    add_text(slide, cx - 1.35, band2_y + 0.0, 2.7, 0.36, fmt_short(args.genre_fans),
             font="Trebuchet MS", size=18, bold=True, color=fg2,
             align=PP_ALIGN.CENTER)

    add_text(slide, cx - 1.05, band3_y - 0.24, 2.1, 0.26, inner_chart.upper()[:18],
             font="Calibri", size=body_pt(L, 7.5), bold=True, color=fg3,
             align=PP_ALIGN.CENTER)
    add_text(slide, cx - 1.05, band3_y + 0.0, 2.1, 0.32, fmt_short(args.ip_fans),
             font="Trebuchet MS", size=15, bold=True, color=fg3,
             align=PP_ALIGN.CENTER)

    add_text(slide, cx - 0.7, cy - 0.30, 1.4, 0.36, fmt_short(args.prev),
             font="Trebuchet MS", size=15, bold=True, color=fg4,
             align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    add_text(slide, cx - 0.7, cy + 0.06, 1.4, 0.26, prev_chart.upper()[:14],
             font="Calibri", size=body_pt(L, 6.5), bold=True, color=fg4,
             align=PP_ALIGN.CENTER)

    # ---- Legend (right half) — kept, per user's "keep side card" pick ----
    rx = 7.7
    add_text(slide, rx, 2.25, 5, 0.3, "POTENTIAL BUYERS BY TIER",
             font="Calibri", size=body_pt(L, 10), bold=True, color=C3)
    add_rect(slide, rx, 2.55, 5.0, 0.012, HAIR)

    _, inner_legend = innermost_label(args)
    inner_desc = "Players of the prior title" if args.inner == "prev" else \
                 "Direct followers of the developer" if args.inner == "dev" else \
                 (args.inner_definition or "")

    rows = [
        (C4, inner_legend,                inner_desc,                              fmt_num(args.prev)),
        (C3, ring2_legend_name(args),     ring2_legend_desc(args),                 fmt_num(args.ip_fans)),
        (C2, cohort3_name(args),          cohort3_desc(args),                      fmt_num(args.genre_fans)),
        (C1, cohort4_name(args),          cohort4_desc(args),                      fmt_num(args.breakout)),
    ]
    # Row heights are computed per-row (not a fixed rh=1.03) because
    # user-typed cohort names can be long enough to wrap to 2 lines --
    # a fixed single-line name box caused the name to visually collide
    # with the description text directly below it.
    name_w = 2.6  # width available before the right-aligned number column
    def _name_line_count(nm: str) -> int:
        return 2 if len(nm) > 22 else 1

    y = 2.75
    for i, (c, name, desc, num) in enumerate(rows):
        n_lines = _name_line_count(name)
        name_h = 0.32 if n_lines == 1 else 0.62
        desc_y_off = 0.36 if n_lines == 1 else 0.66
        row_h = desc_y_off + 0.38
        # Color swatch spans the full row height
        add_rect(slide, rx, y + 0.1, 0.2, row_h - 0.2, c)
        # Name (word_wrap on, so long names wrap onto a 2nd line automatically)
        add_text(slide, rx + 0.4, y + 0.02, name_w, name_h, name,
                 font="Trebuchet MS", size=14, bold=True, color=INK)
        # Description -- offset down when the name wrapped to 2 lines
        add_text(slide, rx + 0.4, y + desc_y_off, 3.5, 0.4, desc,
                 font="Calibri", size=body_pt(L, 9.5), color=MUTED)
        # Number -- widened box + slightly smaller font so large formatted
        # numbers (e.g. "10,000,000") don't wrap awkwardly.
        add_text(slide, rx + 3.1, y + 0.12, 1.9, 0.5, num,
                 font="Trebuchet MS", size=16, bold=True, color=INK,
                 align=PP_ALIGN.RIGHT)
        if i < 3:
            add_rect(slide, rx, y + row_h - 0.06, 5.0, 0.008, HAIR)
        y += row_h

    prs.save(out_path)


# ---------- PNG export ----------
def convert_to_png(pptx_path: str, png_path: str) -> str:
    out_dir = os.path.dirname(os.path.abspath(png_path))
    os.makedirs(out_dir, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            ["soffice", "--headless", "--convert-to", "pdf", "--outdir", tmp, pptx_path],
            check=True, capture_output=True,
        )
        base = os.path.splitext(os.path.basename(pptx_path))[0]
        pdf_path = os.path.join(tmp, base + ".pdf")
        prefix = os.path.join(tmp, "slide")
        subprocess.run(
            ["pdftoppm", "-png", "-r", "200", pdf_path, prefix],
            check=True, capture_output=True,
        )
        produced = None
        for fn in sorted(os.listdir(tmp)):
            if fn.startswith("slide-") and fn.endswith(".png"):
                produced = os.path.join(tmp, fn)
                break
        if not produced:
            raise RuntimeError("pdftoppm did not produce a PNG")
        with open(produced, "rb") as src, open(png_path, "wb") as dst:
            dst.write(src.read())
    return png_path


# ---------- CLI ----------
def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--title", required=True)
    p.add_argument("--genre", required=True)
    p.add_argument(
        "--type", required=True,
        choices=["sequel", "new_ip_with_fans", "custom"],
        help="sequel | new_ip_with_fans | custom (custom = neither sequel nor IP-based; ring 2 is user-defined)",
    )
    p.add_argument(
        "--theme", required=True, choices=["dark", "light"],
        help="dark = V2 Modern Mono; light = V4 Bold Brand",
    )
    p.add_argument(
        "--inner", required=True, choices=["prev", "dev", "other"],
        help="Innermost circle cohort: prev (Prev Game Owners) | dev (Developer Fans) | other (custom)",
    )
    p.add_argument("--inner-name", default=None,
                   help="Custom innermost label (required when --inner other)")
    p.add_argument("--inner-definition", default=None,
                   help="Optional one-line definition shown in legend for the innermost cohort when --inner other")

    p.add_argument("--prev", type=int, required=True,
                   help="Innermost cohort size (prev owners / dev fans / custom inner)")
    p.add_argument("--ip-fans", type=int, required=True,
                   help="Ring 2 cohort size")
    p.add_argument("--genre-fans", type=int, required=True)
    p.add_argument("--breakout", type=int, required=True)

    p.add_argument("--ring2-name", default=None,
                   help="Custom cohort name for ring 2 (required when --type custom)")
    p.add_argument("--ring2-definition", default=None,
                   help="One-line definition shown in legend for ring 2 (required when --type custom)")

    p.add_argument("--cohort3-name", default=None,
                   help="User-typed name for cohort 3 (ring 2 from outside / 'genre fans' slot). "
                        "Falls back to 'Genre Fans' only if omitted -- the wizard always supplies this.")
    p.add_argument("--cohort3-definition", default=None,
                   help="Optional one-line definition for cohort 3 shown in the side legend.")
    p.add_argument("--cohort4-name", default=None,
                   help="User-typed name for cohort 4 (outer ring / 'breakout ceiling' slot). "
                        "Falls back to 'Breakout Ceiling' only if omitted -- the wizard always supplies this.")
    p.add_argument("--cohort4-definition", default=None,
                   help="Optional one-line definition for cohort 4 shown in the side legend.")

    p.add_argument("--out-dir", required=True)
    args = p.parse_args()

    if args.type == "custom" and (not args.ring2_name or not args.ring2_definition):
        p.error("--ring2-name and --ring2-definition are required when --type custom")
    if args.inner == "other" and not args.inner_name:
        p.error("--inner-name is required when --inner other")
    return args


def main():
    args = parse_args()
    slug = slugify(args.title)
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    pptx_path = os.path.join(out_dir, f"{slug}_sizing_circle_{args.theme}.pptx")
    png_path  = os.path.join(out_dir, f"{slug}_sizing_circle_{args.theme}.png")

    if args.theme == "dark":
        render_dark(args, pptx_path)
    else:
        render_light(args, pptx_path)

    convert_to_png(pptx_path, png_path)
    print(f"PPTX: {pptx_path}")
    print(f"PNG:  {png_path}")


if __name__ == "__main__":
    main()
