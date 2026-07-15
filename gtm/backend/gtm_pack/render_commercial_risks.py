#!/usr/bin/env python3
"""Render the GTM Slide Pack Step 6 'Commercial Risks' slide (V2 Manifesto layout).

Two themes, parity with Step 2 (USP slide):
  - dark   (V2 Modern Mono)  : dark slide, warm gold top bar
  - light  (V4 Bold Brand)   : light slide, left teal stripe

Layout (Manifesto):
  - Left half: bold multi-line wedge statement + supporting line
    (default: "Every launch has drag.|We name it so we can plan around it.")
  - Right half: vertical stack of 1-5 risk cards, each with:
      - a threat-level pill (left, color-coded by severity)
      - a "→ proof" line (accent color, same treatment as USP proof)
      - a "» mitigation" line (ink color, same treatment as USP strategy)

Threat levels: critical | high | medium | low (case-insensitive input,
rendered UPPERCASE). Color coding:
  Critical = red    (#D63A57 light / #E5615A dark)
  High     = orange (#E5A700 light / #FFB454 dark)
  Medium   = gold   (#FFC94D both themes)
  Low      = teal   (#1F9B8E light / #2FA9BD dark)

Outputs both a PPTX and a PNG to --out-dir.
"""
from __future__ import annotations

import argparse
import json
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


# ---------- risk data shape ----------
VALID_LEVELS = ("critical", "high", "medium", "low")


def load_risks(args) -> list[tuple[str, str, str]]:
    """Return list of (threat_level_upper, proof, mitigation). Length 1-5."""
    if args.risks_json:
        with open(args.risks_json, "r") as f:
            raw = json.load(f)
    else:
        raw = json.loads(args.risks)
    if not isinstance(raw, list):
        raise SystemExit("--risks / --risks-json must be a JSON list")
    if not (1 <= len(raw) <= 5):
        raise SystemExit(f"Risk count must be 1-5; got {len(raw)}")
    out = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise SystemExit(f"Risk #{i+1} must be a JSON object")
        try:
            level = item["threat_level"].strip().lower()
            proof = item["proof"].strip()
            mitigation = item["mitigation"].strip()
        except (KeyError, AttributeError, TypeError):
            raise SystemExit(f"Risk #{i+1} missing one of: threat_level, proof, mitigation")
        if level not in VALID_LEVELS:
            raise SystemExit(
                f"Risk #{i+1} threat_level must be one of {VALID_LEVELS}; got '{level}'"
            )
        out.append((level.upper(), proof, mitigation))
    return out


def level_color(level_upper: str, theme: str) -> RGBColor:
    level = level_upper.lower()
    if theme == "dark":
        table = {
            "critical": hex_rgb("#E5615A"),
            "high":     hex_rgb("#FFB454"),
            "medium":   hex_rgb("#FFC94D"),
            "low":      hex_rgb("#2FA9BD"),
        }
    else:
        table = {
            "critical": hex_rgb("#D63A57"),
            "high":     hex_rgb("#E5A700"),
            "medium":   hex_rgb("#FFC94D"),
            "low":      hex_rgb("#1F9B8E"),
        }
    return table[level]


# ============================================================
# THEME: DARK  (V2 Modern Mono)
# ============================================================
def render_dark(args, risks, out_path):
    L = getattr(args, "language", "en")
    BG       = hex_rgb("#0E1116")
    BORDER   = hex_rgb("#1F2530")
    INK      = hex_rgb("#E8E6E1")
    MUTED    = hex_rgb("#8A8F99")
    ACCENT   = hex_rgb("#FFB454")  # warm gold (eyebrow + top bar)

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    # Background + top accent bar (locked)
    add_rect(slide, 0, 0, 13.333, 7.5, BG)
    add_rect(slide, 0, 0, 13.333, 0.08, ACCENT)

    # Title block (locked)
    add_text(slide, 0.6, 0.4, 8, 0.3, "STEP 06 \u00b7 COMMERCIAL RISKS",
             font="Trebuchet MS", size=10, bold=True, color=ACCENT)
    add_text(slide, 0.6, 0.75, 12, 0.85, args.title,
             font="Trebuchet MS", size=34, bold=True, color=INK)
    add_text(slide, 0.6, 1.55, 12, 0.4,
             f"Risks to address \u00b7 {args.genre}",
             font="Calibri", size=body_pt(L, 13), color=MUTED)

    # ---- Left wedge ----
    # Narrower wedge column (was 5.4in) frees up room for the risk list at
    # 5 items, which is the tightest case. The wedge is a manifesto anchor,
    # not a full column -- it reads fine narrower since it's short lines.
    wedge_w = 4.7
    add_text(slide, 0.6, 2.5, wedge_w, 0.3, "THE WEDGE",
             font="Calibri", size=body_pt(L, 10), bold=True, color=ACCENT)
    wedge_lines = (args.wedge.split("|") if args.wedge else [
        "Every launch has drag.",
        "We name it so we can plan",
        "around it.",
    ])
    add_text(slide, 0.6, 2.85, wedge_w, 3.5,
             [ln.strip() for ln in wedge_lines],
             font="Trebuchet MS", size=26, bold=True, color=INK)
    add_text(slide, 0.6, 5.6, wedge_w, 0.8,
             args.wedge_support or
             "Each risk below is tracked with a named owner and a concrete mitigation.",
             font="Calibri", size=body_pt(L, 12), color=MUTED)

    # ---- Right list ----
    # Pill now sits INLINE to the left of the proof line (same row) instead
    # of stacked above it -- this is what was causing the proof/mitigation
    # text of one row to collide with the next row's pill at n=5. Each row
    # now gets generous, evenly divided height with a hairline between.
    rx, ry = 5.75, 2.35
    rw = 7.05
    n = len(risks)
    list_h = 7.1 - ry - 0.2
    rh = list_h / n
    pill_col_w = 1.05
    text_x = rx + pill_col_w
    text_w = rw - pill_col_w
    proof_size = body_pt(L, 11 if n <= 3 else (10 if n == 4 else 9.5))
    mitigation_size = body_pt(L, 10 if n <= 3 else (9.5 if n == 4 else 9))
    row_pad_top = 0.16
    proof_y = row_pad_top
    # Give proof 2 lines of room before mitigation starts
    gap_between = 0.62 if n <= 3 else (0.52 if n == 4 else 0.44)
    mitigation_y = proof_y + gap_between
    for i, (level, proof, mitigation) in enumerate(risks):
        y = ry + i * rh
        c = level_color(level, "dark")
        # Threat-level pill, vertically centered against the proof line's
        # first line of text, sitting in its own column to the left.
        pill_w = 0.9
        pill_h = 0.30
        pill = add_rect(slide, rx, y + proof_y - 0.02, pill_w, pill_h, c)
        tf = pill.text_frame
        tf.margin_left = tf.margin_right = Emu(0)
        tf.margin_top = tf.margin_bottom = Emu(0)
        tf.word_wrap = False
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        r = p.add_run()
        r.text = level
        r.font.name = "Trebuchet MS"
        r.font.size = Pt(9.5)
        r.font.bold = True
        r.font.color.rgb = BG
        add_text(slide, text_x, y + proof_y, text_w, gap_between - 0.06, f"\u2192 {proof}",
                 font="Calibri", size=proof_size, bold=True, color=c)
        add_text(slide, text_x, y + mitigation_y, text_w, rh - mitigation_y - 0.12,
                 f"\u00bb {mitigation}",
                 font="Calibri", size=mitigation_size, color=INK)
        if i < n - 1:
            add_rect(slide, rx, y + rh - 0.06, rw, 0.008, BORDER)

    # Footer (locked dark pattern)
    add_text(slide, 0.6, 7.1, 12, 0.25,
             "GTM SLIDE PACK \u00b7 STEP 06",
             font="Calibri", size=body_pt(L, 8), bold=True, color=MUTED)

    prs.save(out_path)


# ============================================================
# THEME: LIGHT (V4 Bold Brand)
# ============================================================
def render_light(args, risks, out_path):
    L = getattr(args, "language", "en")
    BG       = hex_rgb("#FFFFFF")
    INK      = hex_rgb("#1A1A1A")
    MUTED    = hex_rgb("#5C5C5C")
    HAIR     = hex_rgb("#E8E8E8")
    C3       = hex_rgb("#1F9B8E")  # structural teal (eyebrow + stripe)

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    add_rect(slide, 0, 0, 13.333, 7.5, BG)
    # Left accent stripe (locked)
    add_rect(slide, 0, 0, 0.25, 7.5, C3)

    # Title block (locked)
    add_text(slide, 0.7, 0.5, 11, 0.3, "STEP 06 \u00b7 COMMERCIAL RISKS",
             font="Calibri", size=body_pt(L, 10), bold=True, color=C3)
    add_text(slide, 0.7, 0.85, 12, 0.85, args.title,
             font="Trebuchet MS", size=34, bold=True, color=INK)
    add_text(slide, 0.7, 1.65, 12, 0.4,
             f"Risks to address \u00b7 {args.genre}",
             font="Calibri", size=body_pt(L, 14), color=MUTED)

    # ---- Left wedge ----
    wedge_w = 4.8
    add_text(slide, 0.7, 2.6, wedge_w, 0.3, "THE WEDGE",
             font="Calibri", size=body_pt(L, 10), bold=True, color=C3)
    wedge_lines = (args.wedge.split("|") if args.wedge else [
        "Every launch has drag.",
        "We name it so we can plan",
        "around it.",
    ])
    add_text(slide, 0.7, 2.95, wedge_w, 3.5,
             [ln.strip() for ln in wedge_lines],
             font="Trebuchet MS", size=26, bold=True, color=INK)
    add_text(slide, 0.7, 5.7, wedge_w, 0.8,
             args.wedge_support or
             "Each risk below is tracked with a named owner and a concrete mitigation.",
             font="Calibri", size=body_pt(L, 12), color=MUTED)

    # ---- Right list ----
    rx, ry = 5.85, 2.45
    rw = 6.85
    n = len(risks)
    list_h = 7.1 - ry - 0.2
    rh = list_h / n
    pill_col_w = 1.05
    text_x = rx + pill_col_w
    text_w = rw - pill_col_w
    proof_size = body_pt(L, 11 if n <= 3 else (10 if n == 4 else 9.5))
    mitigation_size = body_pt(L, 10 if n <= 3 else (9.5 if n == 4 else 9))
    row_pad_top = 0.16
    proof_y = row_pad_top
    gap_between = 0.62 if n <= 3 else (0.52 if n == 4 else 0.44)
    mitigation_y = proof_y + gap_between
    for i, (level, proof, mitigation) in enumerate(risks):
        y = ry + i * rh
        c = level_color(level, "light")
        pill_w = 0.9
        pill_h = 0.30
        pill = add_rect(slide, rx, y + proof_y - 0.02, pill_w, pill_h, c)
        tf = pill.text_frame
        tf.margin_left = tf.margin_right = Emu(0)
        tf.margin_top = tf.margin_bottom = Emu(0)
        tf.word_wrap = False
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        r = p.add_run()
        r.text = level
        r.font.name = "Trebuchet MS"
        r.font.size = Pt(9.5)
        r.font.bold = True
        r.font.color.rgb = BG
        add_text(slide, text_x, y + proof_y, text_w, gap_between - 0.06, f"\u2192 {proof}",
                 font="Calibri", size=proof_size, bold=True, color=c)
        add_text(slide, text_x, y + mitigation_y, text_w, rh - mitigation_y - 0.12,
                 f"\u00bb {mitigation}",
                 font="Calibri", size=mitigation_size, color=INK)
        if i < n - 1:
            add_rect(slide, rx, y + rh - 0.06, rw, 0.008, HAIR)

    # Footer (locked light pattern)
    add_text(slide, 0.7, 7.1, 12, 0.25,
             "GTM Slide Pack \u00b7 Step 06",
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
    p.add_argument("--genre", required=True)
    p.add_argument("--theme", required=True, choices=["dark", "light"])
    grp = p.add_mutually_exclusive_group(required=True)
    grp.add_argument("--risks", help="Inline JSON list of {threat_level, proof, mitigation} objects (1-5)")
    grp.add_argument("--risks-json", help="Path to a JSON file containing the risk list")
    p.add_argument("--wedge", default=None,
                   help="Optional manifesto statement, pipe-separated lines (e.g. 'A|B|C').")
    p.add_argument("--wedge-support", default=None,
                   help="Optional one-line supporting sentence under the manifesto.")
    p.add_argument("--out-dir", required=True)
    return p.parse_args()


def main():
    args = parse_args()
    risks = load_risks(args)
    slug = slugify(args.title)
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    pptx_path = os.path.join(out_dir, f"{slug}_commercial_risks_{args.theme}.pptx")
    png_path  = os.path.join(out_dir, f"{slug}_commercial_risks_{args.theme}.png")
    if args.theme == "dark":
        render_dark(args, risks, pptx_path)
    else:
        render_light(args, risks, pptx_path)
    convert_to_png(pptx_path, png_path)
    print(f"PPTX: {pptx_path}")
    print(f"PNG:  {png_path}")


if __name__ == "__main__":
    main()
