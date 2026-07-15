#!/usr/bin/env python3
"""Render the GTM Slide Pack Step 3 'How We Reach' slide (V2 Mini-Map + Stack).

Layout:
  - Left half: small circle chart (mirror of Step 1) as a visual key, with caption
  - Right half: 4 stacked cohort cards (cohort name, KPI right-aligned,
    channels inline as middot-separated list, message)

Cohort labels MUST match the labels used in Step 1's Sizing Circle. Pass them via
the --inner / --ring2 / --type flags so the labels resolve identically.

Two themes, parity with Steps 1 & 2:
  - dark   (V2 Modern Mono)
  - light  (V4 Bold Brand)

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


def add_oval(slide, x, y, w, h, fill, line=None):
    s = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x), Inches(y), Inches(w), Inches(h))
    s.fill.solid()
    s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line
    s.shadow.inherit = False
    s.text_frame.text = ""
    return s


def add_circle(slide, cx, cy, d, fill, line=None, line_w_pt=0.5):
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
             color=None, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
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
        if color is not None:
            r.font.color.rgb = color
    return box


# ---------- Cohort label resolution (same logic as Step 1) ----------
def innermost_label(args) -> str:
    if args.inner == "prev":
        return "Prev Game Owners"
    if args.inner == "dev":
        return "Developer Fans"
    return args.inner_name or "Cohort"


def ring2_label(args) -> str:
    if args.type == "custom":
        return args.ring2_name or "Custom cohort"
    return "IP Fans (no prior)"


def cohort_labels(args) -> list[str]:
    """Inner -> outer, matching circle chart tier order."""
    return [
        innermost_label(args),
        ring2_label(args),
        "Genre Fans",
        "Breakout Ceiling",
    ]


# ---------- Reach data ----------
def load_reach(path_or_inline: str, is_path: bool) -> list[dict]:
    """Load the per-cohort reach data. Must be a JSON list of 4 objects with keys:
      - channels: list[str]  (1-4 entries)
      - message:  str
      - kpi:      str
    Order MUST match cohort tier order: inner -> outer (Prev, IP/Custom, Genre, Breakout).
    """
    if is_path:
        with open(path_or_inline, "r") as f:
            raw = json.load(f)
    else:
        raw = json.loads(path_or_inline)
    if not isinstance(raw, list) or len(raw) != 4:
        raise SystemExit("--reach / --reach-json must be a JSON list of exactly 4 objects "
                         "(one per cohort tier, inner -> outer)")
    out = []
    for i, item in enumerate(raw):
        try:
            ch = item["channels"]
            ms = item["message"].strip()
            kp = item["kpi"].strip()
        except (KeyError, AttributeError, TypeError):
            raise SystemExit(f"Cohort #{i+1} missing one of: channels (list), message, kpi")
        if not isinstance(ch, list) or not (1 <= len(ch) <= 4):
            raise SystemExit(f"Cohort #{i+1} 'channels' must be a list of 1-4 strings")
        out.append({"channels": [c.strip() for c in ch], "message": ms, "kpi": kp})
    return out


# ============================================================
# THEME: DARK  (V2 Modern Mono)
# ============================================================
def render_dark(args, reach, out_path):
    L = getattr(args, "language", "en")
    BG       = hex_rgb("#0E1116")
    BORDER   = hex_rgb("#1F2530")
    INK      = hex_rgb("#E8E6E1")
    MUTED    = hex_rgb("#8A8F99")
    A1       = hex_rgb("#0A2A30")  # outer
    A2       = hex_rgb("#155966")
    A3       = hex_rgb("#2FA9BD")
    A4       = hex_rgb("#7FD8E3")  # inner
    ACCENT   = hex_rgb("#FFB454")  # warm gold (breakout + eyebrow)

    # Tier colors inner -> outer; final tier uses ACCENT to match Step 1
    tier_colors = [A4, A3, A2, ACCENT]
    labels = cohort_labels(args)

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    # Background + top accent bar (locked)
    add_rect(slide, 0, 0, 13.333, 7.5, BG)
    add_rect(slide, 0, 0, 13.333, 0.08, ACCENT)

    # Header (locked)
    add_text(slide, 0.6, 0.4, 10, 0.3, "STEP 03 \u00b7 HOW WE REACH",
             font="Trebuchet MS", size=10, bold=True, color=ACCENT)
    add_text(slide, 0.6, 0.75, 12, 0.85, f"Reaching the audience for {args.title}",
             font="Trebuchet MS", size=34, bold=True, color=INK)
    add_text(slide, 0.6, 1.55, 12, 0.4,
             f"{args.genre}  \u00b7  Channels and message tied to each tier",
             font="Calibri", size=body_pt(L, 13), color=MUTED)

    # ---- Left: mini circle chart as visual key ----
    add_text(slide, 0.6, 2.4, 4.5, 0.3, "FROM THE AUDIENCE MAP",
             font="Calibri", size=body_pt(L, 9), bold=True, color=ACCENT)
    cx, cy = 2.7, 4.7
    add_circle(slide, cx, cy, 3.4, A1, line=BORDER)
    add_circle(slide, cx, cy, 2.6, A2, line=BORDER)
    add_circle(slide, cx, cy, 1.8, A3, line=BORDER)
    add_circle(slide, cx, cy, 1.0, A4, line=BORDER)
    # Innermost label (short) sits inside the inner circle
    inner_short = "PREV" if args.inner == "prev" else \
                  "DEV"  if args.inner == "dev"  else \
                  (args.inner_name or "Cohort")[:8].upper()
    add_text(slide, cx - 0.45, cy - 0.15, 0.9, 0.3, inner_short,
             font="Calibri", size=body_pt(L, 8), bold=True, color=BG,
             align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    # Caption
    add_text(slide, 0.6, 6.55, 4.5, 0.5,
             "Each cohort is reached on its own surfaces. Inner tiers carry "
             "highest conversion; outer tiers carry the breakout.",
             font="Calibri", size=body_pt(L, 10), color=MUTED)

    # ---- Right: cohort cards stacked ----
    rx, ry = 5.6, 2.4
    rw = 7.2
    n = 4
    rh = 4.4 / n
    for i in range(n):
        c = tier_colors[i]
        name = labels[i]
        channels = reach[i]["channels"]
        message  = reach[i]["message"]
        kpi      = reach[i]["kpi"]
        y = ry + i * rh
        # Cohort dot + name
        add_oval(slide, rx, y + 0.12, 0.18, 0.18, c)
        add_text(slide, rx + 0.32, y + 0.02, 4.0, 0.35, name,
                 font="Trebuchet MS", size=14, bold=True, color=INK)
        # KPI right-aligned, color-coded
        add_text(slide, rx + 4.4, y + 0.05, rw - 4.4, 0.35,
                 kpi, font="Calibri", size=body_pt(L, 10), bold=True, color=c,
                 align=PP_ALIGN.RIGHT)
        # Channels inline (middot-separated)
        ch_str = "  \u00b7  ".join(channels)
        add_text(slide, rx + 0.32, y + 0.4, rw - 0.4, 0.3, ch_str,
                 font="Calibri", size=body_pt(L, 9), color=INK)
        # Message
        add_text(slide, rx + 0.32, y + 0.7, rw - 0.4, 0.4, message,
                 font="Calibri", size=body_pt(L, 10), color=MUTED)
        if i < n - 1:
            add_rect(slide, rx, y + rh - 0.05, rw, 0.008, BORDER)

    # Footer (locked dark pattern)
    add_text(slide, 0.6, 7.1, 12, 0.25,
             "GTM SLIDE PACK \u00b7 STEP 03 OF N",
             font="Calibri", size=body_pt(L, 8), bold=True, color=MUTED)

    prs.save(out_path)


# ============================================================
# THEME: LIGHT (V4 Bold Brand)
# ============================================================
def render_light(args, reach, out_path):
    L = getattr(args, "language", "en")
    BG       = hex_rgb("#FFFFFF")
    INK      = hex_rgb("#1A1A1A")
    MUTED    = hex_rgb("#5C5C5C")
    HAIR     = hex_rgb("#E8E8E8")
    # Light tier ramp inner -> outer (matches Step 1 light)
    C4       = hex_rgb("#7DD4C9")  # mint (inner)
    C3       = hex_rgb("#1F9B8E")  # teal
    C2       = hex_rgb("#D63A57")  # rose
    C1       = hex_rgb("#E5A700")  # gold (outer / breakout)

    tier_colors = [C4, C3, C2, C1]
    labels = cohort_labels(args)

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    add_rect(slide, 0, 0, 13.333, 7.5, BG)
    # Left accent stripe (locked light motif)
    add_rect(slide, 0, 0, 0.25, 7.5, C3)

    # Header (locked light pattern)
    add_text(slide, 0.7, 0.5, 11, 0.3, "STEP 03 \u00b7 HOW WE REACH",
             font="Calibri", size=body_pt(L, 10), bold=True, color=C3)
    add_text(slide, 0.7, 0.85, 12, 0.85, f"Reaching the audience for {args.title}",
             font="Trebuchet MS", size=34, bold=True, color=INK)
    add_text(slide, 0.7, 1.65, 12, 0.4,
             f"{args.genre} \u00b7 Channels and message tied to each tier",
             font="Calibri", size=body_pt(L, 14), color=MUTED)

    # ---- Left: mini circle chart ----
    add_text(slide, 0.7, 2.55, 4.5, 0.3, "FROM THE AUDIENCE MAP",
             font="Calibri", size=body_pt(L, 9), bold=True, color=C3)
    cx, cy = 2.8, 4.85
    # Outer -> inner so inner sits on top; thin white separators
    add_circle(slide, cx, cy, 3.4, C1, line=BG, line_w_pt=2)
    add_circle(slide, cx, cy, 2.6, C2, line=BG, line_w_pt=2)
    add_circle(slide, cx, cy, 1.8, C3, line=BG, line_w_pt=2)
    add_circle(slide, cx, cy, 1.0, C4, line=BG, line_w_pt=2)
    inner_short = "PREV" if args.inner == "prev" else \
                  "DEV"  if args.inner == "dev"  else \
                  (args.inner_name or "Cohort")[:8].upper()
    add_text(slide, cx - 0.45, cy - 0.15, 0.9, 0.3, inner_short,
             font="Calibri", size=body_pt(L, 8), bold=True, color=INK,
             align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    add_text(slide, 0.7, 6.6, 4.5, 0.45,
             "Each cohort is reached on its own surfaces. Inner tiers carry "
             "highest conversion; outer tiers carry the breakout.",
             font="Calibri", size=body_pt(L, 10), color=MUTED)

    # ---- Right: cohort cards stacked ----
    rx, ry = 5.7, 2.5
    rw = 7.0
    n = 4
    rh = 4.4 / n
    for i in range(n):
        c = tier_colors[i]
        name = labels[i]
        channels = reach[i]["channels"]
        message  = reach[i]["message"]
        kpi      = reach[i]["kpi"]
        y = ry + i * rh
        add_oval(slide, rx, y + 0.12, 0.18, 0.18, c)
        add_text(slide, rx + 0.32, y + 0.02, 4.0, 0.35, name,
                 font="Trebuchet MS", size=14, bold=True, color=INK)
        add_text(slide, rx + 4.4, y + 0.05, rw - 4.4, 0.35,
                 kpi, font="Calibri", size=body_pt(L, 10), bold=True, color=c,
                 align=PP_ALIGN.RIGHT)
        ch_str = "  \u00b7  ".join(channels)
        add_text(slide, rx + 0.32, y + 0.4, rw - 0.4, 0.3, ch_str,
                 font="Calibri", size=body_pt(L, 9), color=INK)
        add_text(slide, rx + 0.32, y + 0.7, rw - 0.4, 0.4, message,
                 font="Calibri", size=body_pt(L, 10), color=MUTED)
        if i < n - 1:
            add_rect(slide, rx, y + rh - 0.05, rw, 0.008, HAIR)

    # Footer (locked light pattern)
    add_text(slide, 0.7, 7.1, 12, 0.25,
             "GTM Slide Pack \u00b7 Step 03 of N",
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
    p.add_argument(
        "--type", required=True, choices=["sequel", "new_ip_with_fans", "custom"],
        help="Match the value used in Step 1 (controls ring 2 label).",
    )
    p.add_argument(
        "--inner", required=True, choices=["prev", "dev", "other"],
        help="Match the value used in Step 1 (controls innermost label).",
    )
    p.add_argument("--inner-name", default=None,
                   help="Custom innermost label (required when --inner other)")
    p.add_argument("--ring2-name", default=None,
                   help="Custom ring 2 label (required when --type custom)")

    grp = p.add_mutually_exclusive_group(required=True)
    grp.add_argument("--reach", help="Inline JSON list of 4 cohort objects "
                                     "(channels[], message, kpi). Order: inner -> outer.")
    grp.add_argument("--reach-json", help="Path to a JSON file with the cohort list")
    p.add_argument("--out-dir", required=True)
    args = p.parse_args()
    if args.type == "custom" and not args.ring2_name:
        p.error("--ring2-name is required when --type custom")
    if args.inner == "other" and not args.inner_name:
        p.error("--inner-name is required when --inner other")
    return args


def main():
    args = parse_args()
    reach = load_reach(args.reach_json or args.reach, is_path=bool(args.reach_json))
    slug = slugify(args.title)
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    pptx_path = os.path.join(out_dir, f"{slug}_reach_{args.theme}.pptx")
    png_path  = os.path.join(out_dir, f"{slug}_reach_{args.theme}.png")
    if args.theme == "dark":
        render_dark(args, reach, pptx_path)
    else:
        render_light(args, reach, pptx_path)
    convert_to_png(pptx_path, png_path)
    print(f"PPTX: {pptx_path}")
    print(f"PNG:  {png_path}")


if __name__ == "__main__":
    main()
