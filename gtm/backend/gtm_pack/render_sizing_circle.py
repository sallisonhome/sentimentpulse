#!/usr/bin/env python3
"""Render the GTM Slide Pack Step 1 'Target Audiences & Sizing' nested-circle slide.

Two themes baked in:
  - dark   (V2 Modern Mono)  : dark slide, teal ramp + warm gold accent on breakout tier, KPI cards
  - light  (V4 Bold Brand)   : light slide, refined original palette, color-swatch legend rows

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


def slugify(value: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "_", value.strip().lower()).strip("_")
    return s or "untitled"


def fmt_num(n: int) -> str:
    return f"{n:,}"


def fmt_short(n: int) -> str:
    """Format a number compactly for the inner circle (1.2M, 850K, 12.3M)."""
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
             color=None, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, italic=False):
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
        r = p.add_run()
        r.text = line
        r.font.name = font
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.italic = italic
        if color is not None:
            r.font.color.rgb = color
    return box


def add_text_with_hyperlink(slide, x, y, w, h, runs, *, size=9, color=None, align=PP_ALIGN.LEFT):
    """runs: list of (text, url_or_None)."""
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.margin_left = tf.margin_right = Emu(0)
    tf.margin_top = tf.margin_bottom = Emu(0)
    p = tf.paragraphs[0]
    p.alignment = align
    for text, url in runs:
        r = p.add_run()
        r.text = text
        r.font.name = "Calibri"
        r.font.size = Pt(size)
        if color is not None:
            r.font.color.rgb = color
        if url:
            r.hyperlink.address = url
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
    return "IP Fans (no prior)"


def ring2_legend_name(args) -> str:
    if args.type == "custom":
        return args.ring2_name
    return "IP Fans (no prior)"


def ring2_legend_desc(args) -> str:
    if args.type == "custom":
        return args.ring2_definition or ""
    return "Followers of the IP who didn't own previous"


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
    add_text(slide, 0.6, 1.55, 11, 0.4,
             f"{args.genre}  ·  {type_label}  ·  Four-tier audience model",
             font="Calibri", size=body_pt(L, 13), color=MUTED)

    # ---- Circles (left half) ----
    cx, cy = 3.7, 4.7
    add_circle(slide, cx, cy, 5.0, A1, line=BORDER, line_w_pt=0.5)
    add_circle(slide, cx, cy, 3.8, A2, line=BORDER, line_w_pt=0.5)
    add_circle(slide, cx, cy, 2.6, A3, line=BORDER, line_w_pt=0.5)
    add_circle(slide, cx, cy, 1.4, A4, line=BORDER, line_w_pt=0.5)

    # Inner — short number + label, dark text on light teal
    inner_chart, _ = innermost_label(args)
    add_text(slide, cx - 0.7, cy - 0.32, 1.4, 0.5, fmt_short(args.prev),
             font="Trebuchet MS", size=22, bold=True, color=BG,
             align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    add_text(slide, cx - 0.85, cy + 0.05, 1.7, 0.3, inner_chart.upper(),
             font="Calibri", size=body_pt(L, 8), bold=True, color=BG,
             align=PP_ALIGN.CENTER)

    # ---- KPI cards (right half) ----
    _, inner_legend = innermost_label(args)
    inner_desc = "Players of the prior title" if args.inner == "prev" else \
                 "Direct followers of the developer" if args.inner == "dev" else \
                 (args.inner_definition or "")

    cards = [
        (inner_legend.upper(),               fmt_num(args.prev),       inner_desc,                              A4),
        (ring2_legend_name(args).upper(),    fmt_num(args.ip_fans),    ring2_legend_desc(args),                 A3),
        ("GENRE FANS",                        fmt_num(args.genre_fans), f"Top 5 avg in {args.genre}",            A2),
        ("BREAKOUT CEILING",                  fmt_num(args.breakout),   f"Top 2 ever in {args.genre}+",          ACCENT),
    ]
    rx = 7.5
    ry = 2.3
    cw = 5.3
    ch = 1.05
    gap = 0.12
    for i, (label, num, desc, accent) in enumerate(cards):
        y = ry + i * (ch + gap)
        add_rect(slide, rx, y, cw, ch, SURFACE)
        # Tier accent strip — left side, indicates which ring this row maps to
        add_rect(slide, rx, y, 0.06, ch, accent)
        add_text(slide, rx + 0.3, y + 0.13, cw - 0.5, 0.3, label,
                 font="Calibri", size=body_pt(L, 9), bold=True, color=MUTED)
        add_text(slide, rx + 0.3, y + 0.4, cw - 0.5, 0.5, num,
                 font="Trebuchet MS", size=22, bold=True, color=INK)
        add_text(slide, rx + 0.3, y + 0.78, cw - 0.5, 0.25, desc,
                 font="Calibri", size=body_pt(L, 10), color=MUTED)

    # Footer
    add_text(slide, 0.6, 7.1, 12, 0.25,
             "GTM SLIDE PACK · STEP 01 OF N",
             font="Calibri", size=body_pt(L, 8), bold=True, color=MUTED)

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

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    add_rect(slide, 0, 0, 13.333, 7.5, BG)

    # Left accent stripe
    add_rect(slide, 0, 0, 0.25, 7.5, C3)

    # Title block
    add_text(slide, 0.7, 0.5, 11, 0.3, "STEP 01 · TARGET AUDIENCES",
             font="Calibri", size=body_pt(L, 10), bold=True, color=C3)
    add_text(slide, 0.7, 0.85, 11, 0.8, args.title,
             font="Trebuchet MS", size=34, bold=True, color=INK)
    type_label = {"sequel": "Sequel", "new_ip_with_fans": "IP-based",
                  "custom": "Original IP"}[args.type]
    add_text(slide, 0.7, 1.65, 11, 0.4,
             f"{args.genre} · {type_label} · sized as concentric reachable cohorts",
             font="Calibri", size=14, color=MUTED)

    # ---- Circles (left half) ----
    cx, cy = 3.9, 4.8
    add_circle(slide, cx, cy, 5.2, C1, line=BG, line_w_pt=2)
    add_circle(slide, cx, cy, 4.0, C2, line=BG, line_w_pt=2)
    add_circle(slide, cx, cy, 2.8, C3, line=BG, line_w_pt=2)
    add_circle(slide, cx, cy, 1.6, C4, line=BG, line_w_pt=2)

    # Inner — short number + label
    inner_chart, _ = innermost_label(args)
    add_text(slide, cx - 0.8, cy - 0.3, 1.6, 0.4, fmt_short(args.prev),
             font="Trebuchet MS", size=20, bold=True, color=INK,
             align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    add_text(slide, cx - 0.8, cy + 0.05, 1.6, 0.3, inner_chart,
             font="Calibri", size=body_pt(L, 9), color=INK, align=PP_ALIGN.CENTER)

    # ---- Legend (right half) ----
    rx = 7.7
    add_text(slide, rx, 2.4, 5, 0.3, "AUDIENCE TIERS",
             font="Calibri", size=body_pt(L, 10), bold=True, color=C3)
    add_rect(slide, rx, 2.7, 5.0, 0.012, HAIR)

    _, inner_legend = innermost_label(args)
    inner_desc = "Players of the prior title" if args.inner == "prev" else \
                 "Direct followers of the developer" if args.inner == "dev" else \
                 (args.inner_definition or "")

    rows = [
        (C4, inner_legend,                inner_desc,                              fmt_num(args.prev)),
        (C3, ring2_legend_name(args),     ring2_legend_desc(args),                 fmt_num(args.ip_fans)),
        (C2, "Genre Fans",                f"Avg Top 5 in {args.genre}",            fmt_num(args.genre_fans)),
        (C1, "Breakout Ceiling",          f"Avg Top 2 ever in {args.genre}+",      fmt_num(args.breakout)),
    ]
    y0 = 2.9
    rh = 0.95
    for i, (c, name, desc, num) in enumerate(rows):
        y = y0 + i * rh
        # Color swatch
        add_rect(slide, rx, y + 0.1, 0.2, 0.55, c)
        # Name
        add_text(slide, rx + 0.4, y + 0.05, 3.2, 0.35, name,
                 font="Trebuchet MS", size=14, bold=True, color=INK)
        # Description
        add_text(slide, rx + 0.4, y + 0.42, 3.5, 0.3, desc,
                 font="Calibri", size=body_pt(L, 10), color=MUTED)
        # Number
        add_text(slide, rx + 3.6, y + 0.12, 1.4, 0.5, num,
                 font="Trebuchet MS", size=18, bold=True, color=INK,
                 align=PP_ALIGN.RIGHT)
        if i < 3:
            add_rect(slide, rx, y + rh - 0.05, 5.0, 0.008, HAIR)

    # Footer
    add_text(slide, 0.7, 7.1, 12, 0.25,
             "GTM Slide Pack · Step 01 of N",
             font="Calibri", size=body_pt(L, 9), color=MUTED)

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
