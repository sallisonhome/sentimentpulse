#!/usr/bin/env python3
"""Render the GTM Slide Pack Step 7 'Game Description & Razors' slide.

Two themes, parity with the rest of the pack:
  - dark   (V2 Modern Mono)  : dark slide, warm gold top bar
  - light  (V4 Bold Brand)   : light slide, left teal stripe

Layout: three cards stacked vertically, each with a heading and a
word-count pill in the top-right corner:
  1. "100-WORD DESCRIPTION" -- prose body (Calibri 11pt, ink)
  2. "20-WORD RAZOR / TAGLINE" -- short tagline (Trebuchet MS Bold 16pt, ink)
  3. "10-WORD RAZOR / SHORT TAGLINE" -- hero line (Trebuchet MS Bold 22pt, accent)

Word counts are informational only (rendered in the pill) -- values over
the nominal limit are WARNED about on stderr but never hard-fail. All
three fields are required (non-empty); that is enforced.

Outputs both a PPTX and a PNG to --out-dir.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

try:
    from .i18n import body_pt
except ImportError:  # pragma: no cover
    from i18n import body_pt


# ---------- helpers ----------
def hex_rgb(h: str) -> RGBColor:
    h = h.lstrip("#")
    return RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def slugify(value: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "_", value.strip().lower()).strip("_")
    return s or "untitled"


def word_count(text: str) -> int:
    return len(text.split())


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


def add_pill(slide, x, y, text, *, fill, text_color, font="Calibri", size=9):
    """Right-aligned small rounded-rect-look pill (plain rectangle, locked style)."""
    w = 0.35 + 0.085 * len(text)
    pill = add_rect(slide, x - w, y, w, 0.26, fill)
    tf = pill.text_frame
    tf.margin_left = tf.margin_right = Emu(45720)
    tf.margin_top = tf.margin_bottom = Emu(9144)
    tf.word_wrap = False
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    r = p.add_run()
    r.text = text
    r.font.name = font
    r.font.size = Pt(size)
    r.font.bold = True
    r.font.color.rgb = text_color
    return pill


# ---------- validation ----------
def validate_inputs(args):
    for field, label in (("description", "--description"), ("razor_20", "--razor-20"), ("razor_10", "--razor-10")):
        val = getattr(args, field)
        if not val or not val.strip():
            raise SystemExit(f"{label} is required and cannot be empty")

    wc_desc = word_count(args.description)
    wc_r20 = word_count(args.razor_20)
    wc_r10 = word_count(args.razor_10)

    if wc_desc > 100:
        print(f"WARNING: --description is {wc_desc} words (nominal limit 100)", file=sys.stderr)
    if wc_r20 > 20:
        print(f"WARNING: --razor-20 is {wc_r20} words (nominal limit 20)", file=sys.stderr)
    if wc_r10 > 10:
        print(f"WARNING: --razor-10 is {wc_r10} words (nominal limit 10)", file=sys.stderr)

    return wc_desc, wc_r20, wc_r10


# ============================================================
# THEME: DARK  (V2 Modern Mono)
# ============================================================
def render_dark(args, counts, out_path):
    L = getattr(args, "language", "en")
    BG       = hex_rgb("#0E1116")
    SURFACE  = hex_rgb("#161A21")
    BORDER   = hex_rgb("#1F2530")
    INK      = hex_rgb("#E8E6E1")
    MUTED    = hex_rgb("#8A8F99")
    ACCENT   = hex_rgb("#FFB454")  # warm gold

    wc_desc, wc_r20, wc_r10 = counts

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    add_rect(slide, 0, 0, 13.333, 7.5, BG)
    add_rect(slide, 0, 0, 13.333, 0.08, ACCENT)

    add_text(slide, 0.6, 0.4, 10, 0.3, "STEP 07 \u00b7 GAME DESCRIPTION & RAZORS",
             font="Trebuchet MS", size=10, bold=True, color=ACCENT)
    add_text(slide, 0.6, 0.75, 12, 0.85, args.title,
             font="Trebuchet MS", size=34, bold=True, color=INK)
    add_text(slide, 0.6, 1.55, 12, 0.4,
             "For product pages, creative briefs, and headlines",
             font="Calibri", size=body_pt(L, 13), color=MUTED)

    cx, cw = 0.6, 12.13

    # Card 1 -- 100-word description
    y1, h1 = 2.15, 1.85
    add_rect(slide, cx, y1, cw, h1, SURFACE)
    add_rect(slide, cx, y1, 0.06, h1, ACCENT)
    add_text(slide, cx + 0.35, y1 + 0.2, cw - 2, 0.3, "100-WORD DESCRIPTION",
             font="Calibri", size=body_pt(L, 10), bold=True, color=MUTED)
    add_pill(slide, cx + cw - 0.3, y1 + 0.18, f"{wc_desc} words", fill=BORDER, text_color=INK)
    add_text(slide, cx + 0.35, y1 + 0.55, cw - 0.7, h1 - 0.75, args.description,
             font="Calibri", size=body_pt(L, 11), color=INK)

    # Card 2 -- 20-word razor / tagline
    y2, h2 = y1 + h1 + 0.25, 1.15
    add_rect(slide, cx, y2, cw, h2, SURFACE)
    add_rect(slide, cx, y2, 0.06, h2, ACCENT)
    add_text(slide, cx + 0.35, y2 + 0.16, cw - 2, 0.3, "20-WORD RAZOR / TAGLINE",
             font="Calibri", size=body_pt(L, 10), bold=True, color=MUTED)
    add_pill(slide, cx + cw - 0.3, y2 + 0.14, f"{wc_r20} words", fill=BORDER, text_color=INK)
    add_text(slide, cx + 0.35, y2 + 0.48, cw - 0.7, 0.6, args.razor_20,
             font="Trebuchet MS", size=16, bold=True, color=INK)

    # Card 3 -- 10-word razor -- hero line
    y3, h3 = y2 + h2 + 0.25, 1.15
    add_rect(slide, cx, y3, cw, h3, SURFACE)
    add_rect(slide, cx, y3, 0.06, h3, ACCENT)
    add_text(slide, cx + 0.35, y3 + 0.16, cw - 2, 0.3, "10-WORD RAZOR / SHORT TAGLINE",
             font="Calibri", size=body_pt(L, 10), bold=True, color=MUTED)
    add_pill(slide, cx + cw - 0.3, y3 + 0.14, f"{wc_r10} words", fill=BORDER, text_color=INK)
    add_text(slide, cx + 0.35, y3 + 0.42, cw - 0.7, 0.65, args.razor_10,
             font="Trebuchet MS", size=22, bold=True, color=ACCENT, align=PP_ALIGN.CENTER)

    add_text(slide, 0.6, 7.1, 12, 0.25,
             "GTM SLIDE PACK \u00b7 STEP 07",
             font="Calibri", size=body_pt(L, 8), bold=True, color=MUTED)

    prs.save(out_path)


# ============================================================
# THEME: LIGHT (V4 Bold Brand)
# ============================================================
def render_light(args, counts, out_path):
    L = getattr(args, "language", "en")
    BG       = hex_rgb("#FFFFFF")
    INK      = hex_rgb("#1A1A1A")
    MUTED    = hex_rgb("#5C5C5C")
    HAIR     = hex_rgb("#E8E8E8")
    PILLBG   = hex_rgb("#F2F2F2")
    C3       = hex_rgb("#1F9B8E")  # structural teal

    wc_desc, wc_r20, wc_r10 = counts

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    add_rect(slide, 0, 0, 13.333, 7.5, BG)
    add_rect(slide, 0, 0, 0.25, 7.5, C3)

    add_text(slide, 0.7, 0.5, 11, 0.3, "STEP 07 \u00b7 GAME DESCRIPTION & RAZORS",
             font="Calibri", size=body_pt(L, 10), bold=True, color=C3)
    add_text(slide, 0.7, 0.85, 12, 0.85, args.title,
             font="Trebuchet MS", size=34, bold=True, color=INK)
    add_text(slide, 0.7, 1.65, 12, 0.4,
             "For product pages, creative briefs, and headlines",
             font="Calibri", size=body_pt(L, 14), color=MUTED)

    cx, cw = 0.7, 12.0

    # Card 1 -- 100-word description
    y1, h1 = 2.2, 1.85
    add_rect(slide, cx, y1, cw, h1, BG, line=HAIR)
    add_text(slide, cx + 0.3, y1 + 0.2, cw - 2, 0.3, "100-WORD DESCRIPTION",
             font="Calibri", size=body_pt(L, 10), bold=True, color=C3)
    add_pill(slide, cx + cw - 0.25, y1 + 0.18, f"{wc_desc} words", fill=PILLBG, text_color=INK)
    add_text(slide, cx + 0.3, y1 + 0.55, cw - 0.6, h1 - 0.75, args.description,
             font="Calibri", size=body_pt(L, 11), color=INK)

    # Card 2 -- 20-word razor / tagline
    y2, h2 = y1 + h1 + 0.25, 1.15
    add_rect(slide, cx, y2, cw, h2, BG, line=HAIR)
    add_text(slide, cx + 0.3, y2 + 0.16, cw - 2, 0.3, "20-WORD RAZOR / TAGLINE",
             font="Calibri", size=body_pt(L, 10), bold=True, color=C3)
    add_pill(slide, cx + cw - 0.25, y2 + 0.14, f"{wc_r20} words", fill=PILLBG, text_color=INK)
    add_text(slide, cx + 0.3, y2 + 0.48, cw - 0.6, 0.6, args.razor_20,
             font="Trebuchet MS", size=16, bold=True, color=INK)

    # Card 3 -- 10-word razor -- hero line
    y3, h3 = y2 + h2 + 0.25, 1.15
    add_rect(slide, cx, y3, cw, h3, BG, line=HAIR)
    add_text(slide, cx + 0.3, y3 + 0.16, cw - 2, 0.3, "10-WORD RAZOR / SHORT TAGLINE",
             font="Calibri", size=body_pt(L, 10), bold=True, color=C3)
    add_pill(slide, cx + cw - 0.25, y3 + 0.14, f"{wc_r10} words", fill=PILLBG, text_color=INK)
    add_text(slide, cx + 0.3, y3 + 0.42, cw - 0.6, 0.65, args.razor_10,
             font="Trebuchet MS", size=22, bold=True, color=C3, align=PP_ALIGN.CENTER)

    add_text(slide, 0.7, 7.1, 12, 0.25,
             "GTM Slide Pack \u00b7 Step 07",
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
    p.add_argument("--title", required=True, help="Game title")
    p.add_argument("--genre", required=True, help="Kept for CLI parity; not shown on this slide")
    p.add_argument("--theme", required=True, choices=["dark", "light"])
    p.add_argument("--description", required=True, help="Product-page description, nominally <=100 words")
    p.add_argument("--razor-20", dest="razor_20", required=True, help="Tagline, nominally <=20 words")
    p.add_argument("--razor-10", dest="razor_10", required=True, help="Short hero tagline, nominally <=10 words")
    p.add_argument("--out-dir", required=True)
    return p.parse_args()


def main():
    args = parse_args()
    counts = validate_inputs(args)
    slug = slugify(args.title)
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    pptx_path = os.path.join(out_dir, f"{slug}_description_razors_{args.theme}.pptx")
    png_path  = os.path.join(out_dir, f"{slug}_description_razors_{args.theme}.png")
    if args.theme == "dark":
        render_dark(args, counts, pptx_path)
    else:
        render_light(args, counts, pptx_path)
    convert_to_png(pptx_path, png_path)
    print(f"PPTX: {pptx_path}")
    print(f"PNG:  {png_path}")


if __name__ == "__main__":
    main()
