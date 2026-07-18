#!/usr/bin/env python3
"""Render the GTM Slide Pack Step 2 'USP / Pillars' slide (V2 Manifesto layout).

Two themes, parity with Step 1:
  - dark   (V2 Modern Mono)  : dark slide, teal ramp + warm gold accent on last pillar
  - light  (V4 Bold Brand)   : light slide, mint/teal/rose/gold tier ramp, left teal stripe

v7 polish pass (2026-07-18): the single fixed-height full-width row layout
that caused severe text-on-text overlap for longer descriptions/proof lines
is replaced with a CARD layout (bordered card per USP, generous internal
padding) plus a MULTI-SLIDE split: 1-3 enabled USPs render on one slide;
4-5 enabled USPs render across TWO slides (items 1-3, then remaining items),
each page carrying a "(N OF M)" eyebrow suffix. Card heights are computed
from an estimated wrapped-line count for the description text so long
descriptions get taller cards instead of overlapping the next card.
Footer removed (global v7 rule).

Outputs both a PPTX and a PNG to --out-dir. `render_dark()`/`render_light()`
now add ONE OR TWO slides to the given Presentation and return it.
"""
from __future__ import annotations

import argparse
import json
import math
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


def est_wrapped_lines(text: str, width_in: float, pt_size: float,
                       chars_per_inch_at_10pt: float = 16.5,
                       safety_margin: float = 1.18) -> int:
    """Estimate how many lines `text` will wrap to inside a box of
    `width_in` inches at font size `pt_size`.

    Calibrated against real soffice-rendered Calibri output (v7 polish pass):
    a 10.5pt paragraph in a ~10.6in-wide box wraps at ~155 chars/line, i.e.
    ~14.6 chars/inch. `chars_per_inch_at_10pt` is scaled by 10/pt_size to
    approximate other sizes, then a `safety_margin` shrinks the effective
    chars-per-line so this estimator deliberately OVER-counts lines rather
    than under-counts -- under-counting is what caused the v6 overlap bug
    where proof/strategy text collided with a description that wrapped to
    more lines than budgeted.
    """
    if not text:
        return 1
    chars_per_inch = chars_per_inch_at_10pt * (10.0 / pt_size) / safety_margin
    chars_per_line = max(8, int(width_in * chars_per_inch))
    total = 0
    for segment in text.split("\n"):
        n_chars = len(segment)
        total += max(1, math.ceil(n_chars / chars_per_line))
    return max(1, total)


# ---------- shape primitives ----------
def add_rect(slide, x, y, w, h, fill, line=None, line_w_pt=1.0):
    s = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
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


# ---------- USP data shape ----------
def load_usps(args) -> list[tuple[str, str, str, str]]:
    """Return list of (title, description, proof, strategy). Length 1-5.

    Backward compatible: entries without `enabled` are treated as enabled;
    entries without `strategy` get an empty strategy string (no strategy
    line rendered). Entries with enabled=false are dropped entirely before
    the 1-5 count check.
    """
    if args.usps_json:
        with open(args.usps_json, "r") as f:
            raw = json.load(f)
    else:
        raw = json.loads(args.usps)
    if not isinstance(raw, list):
        raise SystemExit("--usps / --usps-json must be a JSON list")

    enabled_items = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise SystemExit(f"USP #{i+1} must be a JSON object")
        if not item.get("enabled", True):
            continue  # skip disabled rows entirely
        try:
            t = item["title"].strip()
            d = item["description"].strip()
            p = item["proof"].strip()
        except (KeyError, AttributeError, TypeError):
            raise SystemExit(f"USP #{i+1} missing one of: title, description, proof")
        s = (item.get("strategy") or "").strip()
        enabled_items.append((t, d, p, s))

    if not (1 <= len(enabled_items) <= 5):
        raise SystemExit(f"Enabled USP count must be 1-5; got {len(enabled_items)}")
    return enabled_items


# ---------- accent ramps (4 entries; we slice for 3 or 5) ----------
def dark_accents() -> list[RGBColor]:
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
    """Expand/contract the 4-color ramp to exactly n colors (1-5 supported)."""
    if n == 1:
        return [base[0]]
    if n == 2:
        return [base[0], base[3]]
    if n == 3:
        return [base[0], base[1], base[3]]
    if n == 4:
        return list(base)
    if n == 5:
        mid = RGBColor(
            (base[1][0] + base[2][0]) // 2,
            (base[1][1] + base[2][1]) // 2,
            (base[1][2] + base[2][2]) // 2,
        )
        return [base[0], base[1], mid, base[2], base[3]]
    raise SystemExit(f"Unsupported USP count: {n}")


# ---------- multi-slide chunking (LOCKED split rule) ----------
def chunk_items(items: list, chunk_size: int = 3) -> list[list]:
    """Split into pages of at most `chunk_size` items.

    Locked split rule: 1-3 items = 1 page. 4-5 items = 2 pages (first page
    gets `chunk_size` items, remainder goes on page 2) -- i.e. 4 items =
    [3, 1], 5 items = [3, 2]. Never more than 2 pages for the 1-5 USP range.
    """
    if len(items) <= chunk_size:
        return [items]
    return [items[:chunk_size], items[chunk_size:]]


# ---------- shared per-theme card renderer ----------
# ---------- shared per-theme card renderer ----------
# ---------- shared per-theme card renderer ----------
def _measure_page(usps_page, text_w, desc_size, title_size,
                   title_line_h, desc_line_h, band_line_h, pad):
    """Return (natural_heights, desc_lines_list, title_lines_list) for the
    given font sizes -- pure measurement, no drawing.
    """
    natural_heights, desc_lines_list, title_lines_list = [], [], []
    for (title, desc, proof, strategy) in usps_page:
        title_lines = est_wrapped_lines(title, text_w, title_size)
        desc_lines = est_wrapped_lines(desc, text_w, desc_size) if desc else 0
        band_lines = (1 if proof else 0) + (1 if strategy else 0)
        content_h = (
            pad
            + max(1, title_lines) * title_line_h
            + 0.12
            + desc_lines * desc_line_h
            + 0.14
            + band_lines * band_line_h
            + pad
        )
        natural_heights.append(content_h)
        desc_lines_list.append(desc_lines)
        title_lines_list.append(title_lines)
    return natural_heights, desc_lines_list, title_lines_list


def _render_page(slide, args, usps_page, accents_page, page_num, total_pages,
                  *, theme: str, colors: dict):
    """Render one page (slide) of up to 3 USP cards. `colors` carries the
    theme-specific palette so this single function drives both themes.

    Layout strategy (v7 polish pass):
      1. Measure natural content height per card at the BASE font sizes
         (title 15pt, desc 10.5pt, proof/strategy ~10-10.5pt).
      2. If it fits within the available area, distribute leftover space
         as extra breathing room between cards (capped) -- this avoids the
         old bug where a lone short card on a 2nd split-page stretched into
         a mostly-empty giant box.
      3. If it does NOT fit, shrink title/desc/band font sizes together in
         steps (down to a floor) and re-measure at each step until content
         fits, or the floor is reached. This directly fixes the v6/v7-draft
         bug where box heights were scaled down without shrinking the font
         that renders inside them, causing text to overflow its card.
      4. Only if even the floor size still doesn't fit (extreme edge case:
         very long text on all 3 cards) do we fall back to proportionally
         scaling card heights to fill the area exactly -- this can leave
         text slightly tight but keeps cards from colliding with each other.
    """
    L = getattr(args, "language", "en")
    BG, SURFACE, BORDER, INK, MUTED, ACCENT, STRIPE = (
        colors["BG"], colors["SURFACE"], colors["BORDER"], colors["INK"],
        colors["MUTED"], colors["ACCENT"], colors["STRIPE"],
    )

    if theme == "dark":
        add_rect(slide, 0, 0, 13.333, 7.5, BG)
        add_rect(slide, 0, 0, 13.333, 0.08, ACCENT)
        margin_x = 0.6
        eyebrow_color = ACCENT
    else:
        add_rect(slide, 0, 0, 13.333, 7.5, BG)
        add_rect(slide, 0, 0, 0.25, 7.5, STRIPE)
        margin_x = 0.7
        eyebrow_color = STRIPE

    suffix = f" ({page_num} OF {total_pages})" if total_pages > 1 else ""
    eyebrow = f"PILLARS{suffix}"
    add_text(slide, margin_x, 0.4 if theme == "dark" else 0.5,
             10, 0.3, eyebrow,
             font=("Trebuchet MS" if theme == "dark" else "Calibri"),
             size=10 if theme == "dark" else body_pt(L, 10),
             bold=True, color=eyebrow_color)
    add_text(slide, margin_x, 0.75 if theme == "dark" else 0.85,
             12, 0.85, f"What sets {args.title} apart",
             font="Trebuchet MS", size=34, bold=True, color=INK)
    add_text(slide, margin_x, 1.55 if theme == "dark" else 1.65,
             12, 0.4,
             f"{args.genre} \u00b7 The pillars carrying the launch \u00b7 Each pillar is independently defensible.",
             font="Calibri", size=body_pt(L, 13 if theme == "dark" else 14), color=MUTED)

    # ---- Card list geometry ----
    rx = margin_x
    ry = 2.3 if theme == "dark" else 2.4
    rw = 13.333 - 2 * margin_x
    n = len(usps_page)
    area_top = ry
    area_bottom = 7.25
    area_h = area_bottom - area_top
    gap = 0.2
    pad = 0.24
    num_col_w = 0.6
    text_x_offset = 0.28 + num_col_w
    text_w = rw - 0.28 - num_col_w - pad

    # ---- Font-size shrink ladder (title, desc, proof/strategy, line-heights) ----
    # Each rung shrinks together so type hierarchy is preserved.
    FONT_STEPS = [
        dict(title=15, desc=10.5, band=10.5, title_lh=0.32, desc_lh=0.185, band_lh=0.23),
        dict(title=14, desc=9.7,  band=9.7,  title_lh=0.30, desc_lh=0.175, band_lh=0.22),
        dict(title=13, desc=9.0,  band=9.0,  title_lh=0.28, desc_lh=0.165, band_lh=0.21),
        dict(title=12.5, desc=8.5, band=8.5, title_lh=0.26, desc_lh=0.155, band_lh=0.20),
    ]

    chosen = FONT_STEPS[-1]
    natural_heights = desc_lines_list = title_lines_list = None
    for step in FONT_STEPS:
        nh, dl, tl = _measure_page(
            usps_page, text_w, step["desc"], step["title"],
            step["title_lh"], step["desc_lh"], step["band_lh"], pad,
        )
        total_natural = sum(nh) + gap * (n - 1)
        if total_natural <= area_h:
            chosen = step
            natural_heights, desc_lines_list, title_lines_list = nh, dl, tl
            break
    else:
        # Even the smallest font rung doesn't fit as-is. Rather than only
        # shrinking box heights (which left font size untouched and caused
        # text to spill past its box in extreme worst-case density), TRUNCATE
        # each description to a max-lines budget at the floor font size so
        # the description physically cannot overflow into the proof/strategy
        # band. This only triggers on unusually dense content (e.g. 3 USPs
        # each with 900+ character descriptions) -- normal USP copy fits
        # within the shrink ladder above without ever reaching this branch.
        chosen = FONT_STEPS[-1]
        max_desc_lines = 4  # hard cap per card at the floor rung
        truncated_page = []
        for (title, desc, proof, strategy) in usps_page:
            budget_chars = int(text_w * 16.5 * (10.0 / chosen["desc"]) / 1.18) * max_desc_lines
            if desc and len(desc) > budget_chars:
                cut = desc[: max(0, budget_chars - 1)].rstrip()
                desc = cut + "\u2026"
            truncated_page.append((title, desc, proof, strategy))
        usps_page = truncated_page
        natural_heights, desc_lines_list, title_lines_list = _measure_page(
            usps_page, text_w, chosen["desc"], chosen["title"],
            chosen["title_lh"], chosen["desc_lh"], chosen["band_lh"], pad,
        )
        # Clamp desc_lines_list to the cap so box math matches the truncation.
        desc_lines_list = [min(d, max_desc_lines) for d in desc_lines_list]

    title_size = chosen["title"]
    desc_size = chosen["desc"]
    band_size = chosen["band"]
    title_line_h = chosen["title_lh"]
    desc_line_h = chosen["desc_lh"]
    band_line_h = chosen["band_lh"]

    total_natural = sum(natural_heights) + gap * (n - 1)
    if total_natural <= area_h:
        leftover = area_h - total_natural
        extra_gap = min(leftover / max(1, n), 0.5)
        card_heights = list(natural_heights)
        eff_gap = gap + extra_gap
    else:
        # Still doesn't fit even after truncation (e.g. very long titles
        # alone) -- scale card heights down to fill area_h exactly. Cards
        # will never overlap each other; at most, text sits close to a
        # card's own bottom edge in this rare residual case.
        scale = area_h / total_natural if total_natural > 0 else 1.0
        card_heights = [h * scale for h in natural_heights]
        eff_gap = gap * scale

    # ---- Render using computed heights + chosen font sizes ----
    y = area_top
    for i, ((title, desc, proof, strategy), c) in enumerate(zip(usps_page, accents_page)):
        card_h = card_heights[i]
        add_rect(slide, rx, y, rw, card_h, SURFACE if theme == "dark" else BG,
                 line=(BORDER if theme == "dark" else colors["HAIR"]), line_w_pt=1.0)
        add_rect(slide, rx, y, 0.06, card_h, c)

        text_x = rx + text_x_offset
        num_x = rx + 0.28

        add_text(slide, num_x, y + pad - 0.02, num_col_w, 0.4, f"0{i+1}",
                 font="Trebuchet MS", size=16, bold=True, color=c)
        add_text(slide, text_x, y + pad - 0.02, text_w, 0.4, title,
                 font="Trebuchet MS", size=title_size, bold=True, color=INK)

        title_lines = title_lines_list[i]
        desc_y = y + pad + max(1, title_lines) * title_line_h + 0.1
        desc_lines = desc_lines_list[i]
        desc_h = max(0.2, desc_lines * desc_line_h + 0.08)
        if desc:
            add_text(slide, text_x, desc_y, text_w, desc_h, desc,
                     font="Calibri", size=body_pt(L, desc_size), color=MUTED,
                     line_spacing=1.08)

        # Proof + strategy sit directly below the description's OWN measured
        # height (not a fixed footer band), so they never collide with
        # description text regardless of how many lines it wrapped to.
        band_y = desc_y + desc_h + 0.05
        if proof:
            add_text(slide, text_x, band_y, text_w, 0.22, f"\u2192 {proof}",
                     font="Calibri", size=body_pt(L, band_size), bold=True, color=c,
                     line_spacing=1.0)
            band_y += band_line_h
        if strategy:
            add_text(slide, text_x, band_y, text_w, 0.22, f"\u00bb {strategy}",
                     font="Calibri", size=body_pt(L, band_size - 0.5), color=INK,
                     line_spacing=1.0)

        y += card_h + eff_gap


# ============================================================
# THEME: DARK  (V2 Modern Mono)
# ============================================================
def render_dark(args, usps, out_path_or_prs):
    """Render 1 or 2 slides (per the locked split rule) into a Presentation
    and save it. Accepts either a path (creates a fresh Presentation) so the
    CLI/standalone use case keeps working, matching prior call signature.
    """
    colors = dict(
        BG=hex_rgb("#0E1116"), SURFACE=hex_rgb("#161A21"), BORDER=hex_rgb("#1F2530"),
        INK=hex_rgb("#E8E6E1"), MUTED=hex_rgb("#8A8F99"), ACCENT=hex_rgb("#FFB454"),
        STRIPE=hex_rgb("#FFB454"), HAIR=hex_rgb("#1F2530"),
    )

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    accents_all = expand_accents(dark_accents(), len(usps))
    pages = chunk_items(list(zip(usps, accents_all)), chunk_size=3)
    total_pages = len(pages)

    for page_num, page in enumerate(pages, start=1):
        usps_page = [p[0] for p in page]
        accents_page = [p[1] for p in page]
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        _render_page(slide, args, usps_page, accents_page, page_num, total_pages,
                     theme="dark", colors=colors)

    prs.save(out_path_or_prs)
    return prs


# ============================================================
# THEME: LIGHT (V4 Bold Brand)
# ============================================================
def render_light(args, usps, out_path_or_prs):
    colors = dict(
        BG=hex_rgb("#FFFFFF"), SURFACE=hex_rgb("#FFFFFF"), BORDER=hex_rgb("#E8E8E8"),
        INK=hex_rgb("#1A1A1A"), MUTED=hex_rgb("#5C5C5C"), ACCENT=hex_rgb("#1F9B8E"),
        STRIPE=hex_rgb("#1F9B8E"), HAIR=hex_rgb("#E8E8E8"),
    )

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    accents_all = expand_accents(light_accents(), len(usps))
    pages = chunk_items(list(zip(usps, accents_all)), chunk_size=3)
    total_pages = len(pages)

    for page_num, page in enumerate(pages, start=1):
        usps_page = [p[0] for p in page]
        accents_page = [p[1] for p in page]
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        _render_page(slide, args, usps_page, accents_page, page_num, total_pages,
                     theme="light", colors=colors)

    prs.save(out_path_or_prs)
    return prs


# ---------- PNG export ----------
def convert_to_png(pptx_path: str, png_dir: str) -> list[str]:
    """Convert every slide in pptx_path to a PNG. Returns list of PNG paths
    (one per slide, in order) -- multi-slide-aware (v7), unlike the old
    single-PNG-per-pptx assumption.
    """
    os.makedirs(png_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(pptx_path))[0]
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            ["soffice", "--headless", "--convert-to", "pdf", "--outdir", tmp, pptx_path],
            check=True, capture_output=True,
        )
        pdf_path = os.path.join(tmp, base + ".pdf")
        prefix = os.path.join(tmp, "slide")
        subprocess.run(
            ["pdftoppm", "-png", "-r", "200", pdf_path, prefix],
            check=True, capture_output=True,
        )
        produced = sorted(fn for fn in os.listdir(tmp) if fn.startswith("slide-") and fn.endswith(".png"))
        out_paths = []
        for i, fn in enumerate(produced, start=1):
            dest = os.path.join(png_dir, f"{base}_p{i}.png")
            with open(os.path.join(tmp, fn), "rb") as src, open(dest, "wb") as dst:
                dst.write(src.read())
            out_paths.append(dest)
    return out_paths


# ---------- CLI ----------
def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--title", required=True, help="Game title")
    p.add_argument("--genre", required=True)
    p.add_argument("--theme", required=True, choices=["dark", "light"])
    grp = p.add_mutually_exclusive_group(required=True)
    grp.add_argument("--usps", help="Inline JSON list of {title, description, proof, strategy, enabled} objects (1-5 enabled)")
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
    if args.theme == "dark":
        render_dark(args, usps, pptx_path)
    else:
        render_light(args, usps, pptx_path)
    pngs = convert_to_png(pptx_path, out_dir)
    print(f"PPTX: {pptx_path}")
    for p in pngs:
        print(f"PNG:  {p}")


if __name__ == "__main__":
    main()
