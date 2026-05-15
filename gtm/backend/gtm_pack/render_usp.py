#!/usr/bin/env python3
"""Render the GTM Slide Pack Step 2 'USP / Pillars' slide (V2 Manifesto layout).

Two themes, parity with Step 1:
  - dark   (V2 Modern Mono)  : dark slide, teal ramp + warm gold accent on last pillar
  - light  (V4 Bold Brand)   : light slide, mint/teal/rose/gold tier ramp, left teal stripe

Layout (Manifesto):
  - Left half: bold multi-line wedge statement + supporting line
  - Right half: vertical list of USPs (number, title, one-line desc, color-coded proof)

Supports 3-5 USPs (auto-spaces vertically).

Outputs both a PPTX and a PNG to --out-dir.
"""
from __future__ import annotations

import argparse
import json
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


# ---------- helpers ----------
def hex_rgb(h: str) -> RGBColor:
    h = h.lstrip("#")
    return RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def slugify(value: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "_", value.strip().lower()).strip("_")
    return s or "untitled"


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


# ---------- USP data shape ----------
def load_usps(args) -> list[tuple[str, str, str]]:
    """Return list of (title, description, proof). Length 3-5."""
    if args.usps_json:
        with open(args.usps_json, "r") as f:
            raw = json.load(f)
    else:
        raw = json.loads(args.usps)
    if not isinstance(raw, list):
        raise SystemExit("--usps / --usps-json must be a JSON list")
    if not (3 <= len(raw) <= 5):
        raise SystemExit(f"USP count must be 3-5; got {len(raw)}")
    out = []
    for i, item in enumerate(raw):
        try:
            t = item["title"].strip()
            d = item["description"].strip()
            p = item["proof"].strip()
        except (KeyError, AttributeError, TypeError):
            raise SystemExit(f"USP #{i+1} missing one of: title, description, proof")
        out.append((t, d, p))
    return out


# ---------- accent ramps (4 entries; we slice for 3 or 5) ----------
def dark_accents() -> list[RGBColor]:
    # inner→outer-ish, ending on warm gold for the breakout pillar
    A2 = hex_rgb("#155966")
    A3 = hex_rgb("#2FA9BD")
    A4 = hex_rgb("#7FD8E3")
    GOLD = hex_rgb("#FFB454")
    return [A4, A3, A2, GOLD]


def light_accents() -> list[RGBColor]:
    C4 = hex_rgb("#7DD4C9")  # mint
    C3 = hex_rgb("#1F9B8E")  # teal
    C2 = hex_rgb("#D63A57")  # rose
    C1 = hex_rgb("#E5A700")  # gold
    return [C4, C3, C2, C1]


def expand_accents(base: list[RGBColor], n: int) -> list[RGBColor]:
    """Expand 4-color ramp to exactly n colors (3-5 supported)."""
    if n == 3:
        return [base[0], base[1], base[3]]  # skip the middle dark teal/rose
    if n == 4:
        return list(base)
    if n == 5:
        # insert an intermediate between [1] and [2]
        mid = RGBColor(
            (base[1][0] + base[2][0]) // 2,
            (base[1][1] + base[2][1]) // 2,
            (base[1][2] + base[2][2]) // 2,
        )
        return [base[0], base[1], mid, base[2], base[3]]
    raise SystemExit(f"Unsupported USP count: {n}")


# ============================================================
# THEME: DARK  (V2 Modern Mono)
# ============================================================
def render_dark(args, usps, out_path):
    BG       = hex_rgb("#0E1116")
    BORDER   = hex_rgb("#1F2530")
    INK      = hex_rgb("#E8E6E1")
    MUTED    = hex_rgb("#8A8F99")
    ACCENT   = hex_rgb("#FFB454")  # warm gold (eyebrow + top bar)

    accents = expand_accents(dark_accents(), len(usps))

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    # Background + top accent bar (locked)
    add_rect(slide, 0, 0, 13.333, 7.5, BG)
    add_rect(slide, 0, 0, 13.333, 0.08, ACCENT)

    # Title block (locked)
    add_text(slide, 0.6, 0.4, 8, 0.3, "STEP 02 \u00b7 PILLARS",
             font="Trebuchet MS", size=10, bold=True, color=ACCENT)
    add_text(slide, 0.6, 0.75, 12, 0.85, f"What sets {args.title} apart",
             font="Trebuchet MS", size=34, bold=True, color=INK)
    add_text(slide, 0.6, 1.55, 12, 0.4,
             f"{args.genre}  \u00b7  The pillars carrying the launch",
             font="Calibri", size=13, color=MUTED)

    # ---- Left manifesto ----
    add_text(slide, 0.6, 2.5, 5.4, 0.3, "THE WEDGE",
             font="Calibri", size=10, bold=True, color=ACCENT)
    # If user provided a custom wedge statement, use it; else default template
    wedge_lines = (args.wedge.split("|") if args.wedge else [
        f"{args.title} earns its slot",
        "in a crowded genre",
        "through execution \u2014",
        "not novelty.",
    ])
    add_text(slide, 0.6, 2.85, 5.4, 3.5,
             [ln.strip() for ln in wedge_lines],
             font="Trebuchet MS", size=28, bold=True, color=INK)
    add_text(slide, 0.6, 5.6, 5.4, 0.8,
             args.wedge_support or
             "Each pillar is independently defensible and supported by measurable proof.",
             font="Calibri", size=12, color=MUTED)

    # ---- Right list ----
    rx, ry = 6.6, 2.4
    rw = 6.2
    n = len(usps)
    # Available list height: footer at 7.1, leave 0.25" breathing room
    list_h = 7.1 - ry - 0.25
    rh = list_h / n
    # Adjust internal spacing for tighter rows (5 USPs)
    title_size = 13 if n == 5 else 14
    desc_size  = 10
    proof_size = 9
    title_y = 0.05
    desc_y  = 0.40 if n == 5 else 0.45
    proof_y = 0.68 if n == 5 else 0.78
    for i, ((title, desc, proof), c) in enumerate(zip(usps, accents)):
        y = ry + i * rh
        add_text(slide, rx, y + title_y, 0.5, 0.4, f"0{i+1}",
                 font="Trebuchet MS", size=18, bold=True, color=c)
        add_text(slide, rx + 0.7, y + title_y, rw - 1.2, 0.4, title,
                 font="Trebuchet MS", size=title_size, bold=True, color=INK)
        add_text(slide, rx + 0.7, y + desc_y, rw - 1.2, 0.4, desc,
                 font="Calibri", size=desc_size, color=MUTED)
        add_text(slide, rx + 0.7, y + proof_y, rw - 1.2, 0.3, f"\u2192 {proof}",
                 font="Calibri", size=proof_size, bold=True, color=c)
        if i < n - 1:
            add_rect(slide, rx, y + rh - 0.05, rw, 0.008, BORDER)

    # Footer (locked dark pattern)
    add_text(slide, 0.6, 7.1, 12, 0.25,
             "GTM SLIDE PACK \u00b7 STEP 02 OF N",
             font="Calibri", size=8, bold=True, color=MUTED)

    prs.save(out_path)


# ============================================================
# THEME: LIGHT (V4 Bold Brand)
# ============================================================
def render_light(args, usps, out_path):
    BG       = hex_rgb("#FFFFFF")
    INK      = hex_rgb("#1A1A1A")
    MUTED    = hex_rgb("#5C5C5C")
    HAIR     = hex_rgb("#E8E8E8")
    C3       = hex_rgb("#1F9B8E")  # structural teal (eyebrow + stripe)

    accents = expand_accents(light_accents(), len(usps))

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    add_rect(slide, 0, 0, 13.333, 7.5, BG)
    # Left accent stripe (locked)
    add_rect(slide, 0, 0, 0.25, 7.5, C3)

    # Title block (locked)
    add_text(slide, 0.7, 0.5, 11, 0.3, "STEP 02 \u00b7 PILLARS",
             font="Calibri", size=10, bold=True, color=C3)
    add_text(slide, 0.7, 0.85, 12, 0.85, f"What sets {args.title} apart",
             font="Trebuchet MS", size=34, bold=True, color=INK)
    add_text(slide, 0.7, 1.65, 12, 0.4,
             f"{args.genre} \u00b7 The pillars carrying the launch",
             font="Calibri", size=14, color=MUTED)

    # ---- Left manifesto ----
    add_text(slide, 0.7, 2.6, 5.4, 0.3, "THE WEDGE",
             font="Calibri", size=10, bold=True, color=C3)
    wedge_lines = (args.wedge.split("|") if args.wedge else [
        f"{args.title} earns its slot",
        "in a crowded genre",
        "through execution \u2014",
        "not novelty.",
    ])
    add_text(slide, 0.7, 2.95, 5.4, 3.5,
             [ln.strip() for ln in wedge_lines],
             font="Trebuchet MS", size=28, bold=True, color=INK)
    add_text(slide, 0.7, 5.7, 5.4, 0.8,
             args.wedge_support or
             "Each pillar is independently defensible and supported by measurable proof.",
             font="Calibri", size=12, color=MUTED)

    # ---- Right list ----
    rx, ry = 6.7, 2.5
    rw = 6.0
    n = len(usps)
    list_h = 7.1 - ry - 0.25
    rh = list_h / n
    title_size = 13 if n == 5 else 14
    desc_size  = 10
    proof_size = 9
    title_y = 0.05
    desc_y  = 0.40 if n == 5 else 0.45
    proof_y = 0.68 if n == 5 else 0.78
    for i, ((title, desc, proof), c) in enumerate(zip(usps, accents)):
        y = ry + i * rh
        add_text(slide, rx, y + title_y, 0.5, 0.4, f"0{i+1}",
                 font="Trebuchet MS", size=18, bold=True, color=c)
        add_text(slide, rx + 0.7, y + title_y, rw - 1.2, 0.4, title,
                 font="Trebuchet MS", size=title_size, bold=True, color=INK)
        add_text(slide, rx + 0.7, y + desc_y, rw - 1.2, 0.4, desc,
                 font="Calibri", size=desc_size, color=MUTED)
        add_text(slide, rx + 0.7, y + proof_y, rw - 1.2, 0.3, f"\u2192 {proof}",
                 font="Calibri", size=proof_size, bold=True, color=c)
        if i < n - 1:
            add_rect(slide, rx, y + rh - 0.05, rw, 0.008, HAIR)

    # Footer (locked light pattern)
    add_text(slide, 0.7, 7.1, 12, 0.25,
             "GTM Slide Pack \u00b7 Step 02 of N",
             font="Calibri", size=9, color=MUTED)

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
    p.add_argument("--genre", required=True)
    p.add_argument("--theme", required=True, choices=["dark", "light"])
    grp = p.add_mutually_exclusive_group(required=True)
    grp.add_argument("--usps", help="Inline JSON list of {title, description, proof} objects (3-5)")
    grp.add_argument("--usps-json", help="Path to a JSON file containing the USP list")
    p.add_argument("--wedge", default=None,
                   help="Optional manifesto statement, pipe-separated lines (e.g. 'A|B|C').")
    p.add_argument("--wedge-support", default=None,
                   help="Optional one-line supporting sentence under the manifesto.")
    p.add_argument("--out-dir", required=True)
    return p.parse_args()


def main():
    args = parse_args()
    usps = load_usps(args)
    slug = slugify(args.title)
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    pptx_path = os.path.join(out_dir, f"{slug}_usp_{args.theme}.pptx")
    png_path  = os.path.join(out_dir, f"{slug}_usp_{args.theme}.png")
    if args.theme == "dark":
        render_dark(args, usps, pptx_path)
    else:
        render_light(args, usps, pptx_path)
    convert_to_png(pptx_path, png_path)
    print(f"PPTX: {pptx_path}")
    print(f"PNG:  {png_path}")


if __name__ == "__main__":
    main()
