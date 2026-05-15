"""GTM Slide Pack rendering engine.

Lifted from the `gtm-slide-pack-kickoff` user skill (v4.1, May 15 2026).
Exposes callable wrapper functions over the original argparse-driven renderers.

The original render_*.py modules are CLI scripts that parse argparse.Namespace.
This module wraps each one with a function that accepts a dict of inputs,
constructs a Namespace, and invokes the underlying renderer functions directly
(bypassing argparse and sys.exit).
"""

from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import subprocess
import tempfile
from argparse import Namespace
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from pptx import Presentation
from pptx.util import Inches

# Import the underlying renderer modules. The skill modules use absolute paths
# for asset loading — we patch that below.
from . import render_sizing_circle as _sizing
from . import render_usp as _usp
from . import render_reach as _reach
from . import render_roadmap as _roadmap

# Path to bundled assets (roadmap_phases.json etc.)
ASSETS_DIR = Path(__file__).resolve().parent / "assets"


# ── Helpers ───────────────────────────────────────────────────────────────────


def _slugify(value: str) -> str:
    return _sizing.slugify(value)


def _convert_to_pdf(pptx_path: Path, out_dir: Path) -> Path:
    """Convert PPTX to PDF using LibreOffice (soffice). Returns PDF path."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pdf_name = pptx_path.stem + ".pdf"
    pdf_path = out_dir / pdf_name
    # soffice writes to --outdir using same stem
    subprocess.run(
        [
            "soffice", "--headless", "--convert-to", "pdf",
            "--outdir", str(out_dir), str(pptx_path),
        ],
        check=True,
        capture_output=True,
        timeout=120,
    )
    if not pdf_path.exists():
        raise RuntimeError(f"PDF conversion failed: {pdf_path} not produced")
    return pdf_path


def _pdf_to_pngs(pdf_path: Path, out_dir: Path, dpi: int = 110, prefix: str = "slide") -> list[Path]:
    """Render PDF pages to PNGs via pdftoppm. Returns list of PNG paths in order."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["pdftoppm", "-png", "-r", str(dpi), str(pdf_path), str(out_dir / prefix)],
        check=True,
        capture_output=True,
        timeout=120,
    )
    pngs = sorted(out_dir.glob(f"{prefix}-*.png"))
    return pngs


# ── Individual renderers (callable wrappers) ─────────────────────────────────


def render_sizing_circle(inputs: dict[str, Any], theme: str, out_dir: Path) -> Path:
    """Render Step 1 — Sizing Circle. Returns PPTX path."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = _slugify(inputs["title"])

    cohort_sizes = inputs["cohorts"]  # list of 4 dicts with size
    inner_choice = inputs.get("inner", "other")
    game_type = inputs.get("game_type", "custom")

    args = Namespace(
        title=inputs["title"],
        genre=inputs["genre"],
        type=game_type,
        inner=inner_choice,
        inner_name=inputs["cohorts"][0]["name"] if inner_choice == "other" else None,
        inner_definition=inputs.get("inner_definition"),
        prev=int(cohort_sizes[0]["size"]),
        ip_fans=int(cohort_sizes[1]["size"]),
        genre_fans=int(cohort_sizes[2]["size"]),
        breakout=int(cohort_sizes[3]["size"]),
        ring2_name=inputs["cohorts"][1]["name"] if game_type == "custom" else None,
        ring2_definition=inputs.get("ring2_definition"),
        theme=theme,
        out_dir=str(out_dir),
    )

    pptx_path = out_dir / f"{slug}_sizing_circle_{theme}.pptx"
    if theme == "dark":
        _sizing.render_dark(args, str(pptx_path))
    else:
        _sizing.render_light(args, str(pptx_path))
    return pptx_path


def render_usp(inputs: dict[str, Any], theme: str, out_dir: Path) -> Path:
    """Render Step 2 — USP Manifesto. Returns PPTX path."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = _slugify(inputs["title"])

    # Build args namespace; load_usps reads from args.usps (JSON string) or args.usps_json (path)
    usps_payload = inputs["usps"]  # list of {title/description/support OR proof}
    # Normalize "support" -> "proof" for skill compat
    normalized = []
    for u in usps_payload:
        normalized.append({
            "title": u.get("title") or u.get("headline"),
            "description": u.get("description") or u.get("support", ""),
            "proof": u.get("proof") or u.get("support", ""),
        })
    args = Namespace(
        title=inputs["title"],
        genre=inputs["genre"],
        theme=theme,
        usps=json.dumps(normalized),
        usps_json=None,
        wedge=inputs.get("wedge"),
        wedge_support=inputs.get("wedge_support"),
        out_dir=str(out_dir),
    )

    usps = _usp.load_usps(args)
    pptx_path = out_dir / f"{slug}_usp_{theme}.pptx"
    if theme == "dark":
        _usp.render_dark(args, usps, str(pptx_path))
    else:
        _usp.render_light(args, usps, str(pptx_path))
    return pptx_path


def render_reach(inputs: dict[str, Any], theme: str, out_dir: Path) -> Path:
    """Render Step 3 — How We Reach. Returns PPTX path."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = _slugify(inputs["title"])

    inner_choice = inputs.get("inner", "other")
    game_type = inputs.get("game_type", "custom")

    # reach payload from app form: list of 4 {cohort, channel, message, kpi}
    # skill expects: list of 4 {channels:[...], message, kpi}
    reach_payload = []
    for r in inputs["reach"]:
        ch = r.get("channels") or r.get("channel")
        if isinstance(ch, str):
            ch = [c.strip() for c in ch.split(",") if c.strip()]
        reach_payload.append({
            "channels": ch,
            "message": r["message"],
            "kpi": r["kpi"],
        })

    args = Namespace(
        title=inputs["title"],
        genre=inputs["genre"],
        type=game_type,
        inner=inner_choice,
        inner_name=inputs["cohorts"][0]["name"] if inner_choice == "other" else None,
        ring2_name=inputs["cohorts"][1]["name"] if game_type == "custom" else None,
        theme=theme,
        reach=json.dumps(reach_payload),
        reach_json=None,
        out_dir=str(out_dir),
    )

    reach = _reach.load_reach(args.reach, is_path=False)
    pptx_path = out_dir / f"{slug}_reach_{theme}.pptx"
    if theme == "dark":
        _reach.render_dark(args, reach, str(pptx_path))
    else:
        _reach.render_light(args, reach, str(pptx_path))
    return pptx_path


def render_roadmap(inputs: dict[str, Any], theme: str, release_date: dt.date,
                   out_dir: Path, phases_override: dict | None = None) -> Path:
    """Render Step 4 — Roadmap (6 sub-slides). Returns PPTX path."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = _slugify(inputs["title"])

    if phases_override is not None:
        phases = phases_override
    else:
        with open(ASSETS_DIR / "roadmap_phases.json") as f:
            phases = json.load(f)

    args = Namespace(
        title=inputs["title"],
        genre=inputs["genre"],
        release_date=release_date,
        theme=theme,
        phases_json=None,
        out_dir=str(out_dir),
        no_png=True,  # we'll convert via merged-deck PDF later
    )

    anchors = _roadmap.compute_anchors(release_date)

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    slides_data = phases["slides"]
    summary_events = phases.get("summary_events", {}).get("events", [])
    total = len(slides_data) + (1 if summary_events else 0)

    for i, sd in enumerate(slides_data):
        if theme == "dark":
            _roadmap.render_one_dark(prs, sd, i + 1, total, anchors, args)
        else:
            _roadmap.render_one_light(prs, sd, i + 1, total, anchors, args)

    if summary_events:
        slide_num = len(slides_data) + 1
        if theme == "dark":
            _roadmap.render_summary_dark(prs, summary_events, slide_num, total, anchors, args)
        else:
            _roadmap.render_summary_light(prs, summary_events, slide_num, total, anchors, args)

    pptx_path = out_dir / f"{slug}_roadmap_{theme}.pptx"
    prs.save(str(pptx_path))
    return pptx_path


# ── Full-pack merger ─────────────────────────────────────────────────────────


def _copy_slide_from(target_prs: Presentation, source_prs: Presentation, slide_index: int):
    """Copy a slide from source_prs to target_prs at the end.

    python-pptx doesn't have a public slide-copy API. We use a low-level XML
    surgery approach: clone the slide XML and re-register the relationships.
    """
    from copy import deepcopy
    from pptx.oxml.ns import qn

    source_slide = source_prs.slides[slide_index]

    # Pick a blank layout on the target deck
    blank_layout = target_prs.slide_layouts[6]  # "Blank"
    new_slide = target_prs.slides.add_slide(blank_layout)

    # Remove placeholders that came with the blank layout
    for shp in list(new_slide.shapes):
        sp = shp._element
        sp.getparent().remove(sp)

    # Copy all shape XML from source slide
    for shp in source_slide.shapes:
        new_el = deepcopy(shp._element)
        new_slide.shapes._spTree.insert_element_before(new_el, "p:extLst")

    # Copy slide-level background fill if present
    src_cSld = source_slide._element.find(qn("p:cSld"))
    tgt_cSld = new_slide._element.find(qn("p:cSld"))
    src_bg = src_cSld.find(qn("p:bg"))
    if src_bg is not None:
        # Replace target bg if it exists, otherwise insert at front
        tgt_bg = tgt_cSld.find(qn("p:bg"))
        if tgt_bg is not None:
            tgt_cSld.remove(tgt_bg)
        tgt_cSld.insert(0, deepcopy(src_bg))


def render_full_pack(
    inputs: dict[str, Any],
    theme: str,
    out_dir: Path,
    *,
    release_date: dt.date | None = None,
    phases_override: dict | None = None,
) -> Path:
    """Render the complete 9-slide GTM pack.

    Returns the path to the merged PPTX containing all 9 slides:
      1: Sizing Circle
      2: USP Manifesto
      3: How We Reach
      4–9: Roadmap (4.1 through 4.6)

    The release_date kwarg overrides inputs["release_date"] if provided.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = _slugify(inputs["title"])

    # Resolve release date
    if release_date is None:
        rd = inputs.get("release_date")
        if rd is None:
            raise ValueError("release_date is required (in inputs or as kwarg)")
        release_date = dt.date.fromisoformat(rd) if isinstance(rd, str) else rd

    # Render the four sub-decks in parallel (CPU-light, IO-heavy)
    tmp = Path(tempfile.mkdtemp(prefix="gtm_pack_"))
    try:
        with ThreadPoolExecutor(max_workers=4) as ex:
            futures = {
                "sizing":  ex.submit(render_sizing_circle, inputs, theme, tmp),
                "usp":     ex.submit(render_usp, inputs, theme, tmp),
                "reach":   ex.submit(render_reach, inputs, theme, tmp),
                "roadmap": ex.submit(render_roadmap, inputs, theme, release_date,
                                     tmp, phases_override),
            }
            results = {k: f.result() for k, f in futures.items()}

        # Merge in order: sizing → usp → reach → roadmap (6 slides)
        merged = Presentation()
        merged.slide_width = Inches(13.333)
        merged.slide_height = Inches(7.5)
        # Remove default slide that gets added with blank layout
        for order_key in ("sizing", "usp", "reach", "roadmap"):
            src = Presentation(str(results[order_key]))
            for i in range(len(src.slides)):
                _copy_slide_from(merged, src, i)

        merged_path = out_dir / f"{slug}_gtm_pack_{theme}.pptx"
        merged.save(str(merged_path))
        return merged_path
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ── Convenience: render + PDF + PNGs in one call ─────────────────────────────


def render_pack_with_artifacts(
    inputs: dict[str, Any],
    theme: str,
    out_dir: Path,
    *,
    release_date: dt.date | None = None,
    phases_override: dict | None = None,
    preview_dpi: int = 110,
    pdf_dpi: int = 150,
    skip_pngs: bool = False,
) -> dict[str, Any]:
    """Render the full pack and produce PPTX, PDF, and per-slide PNGs.

    Returns:
        {
            "pptx": Path,
            "pdf": Path,
            "pngs": [Path, ...]   # one per slide, in order
        }
    """
    out_dir = Path(out_dir)
    pptx_path = render_full_pack(
        inputs, theme, out_dir,
        release_date=release_date,
        phases_override=phases_override,
    )
    pdf_path = _convert_to_pdf(pptx_path, out_dir)
    pngs = [] if skip_pngs else _pdf_to_pngs(pdf_path, out_dir, dpi=preview_dpi,
                                              prefix=pptx_path.stem)
    return {"pptx": pptx_path, "pdf": pdf_path, "pngs": pngs}


__all__ = [
    "render_sizing_circle",
    "render_usp",
    "render_reach",
    "render_roadmap",
    "render_full_pack",
    "render_pack_with_artifacts",
    "ASSETS_DIR",
]
