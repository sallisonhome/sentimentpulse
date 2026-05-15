"""Phase 0 acceptance test: render_full_pack produces a 9-slide PPTX in both themes."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from pptx import Presentation

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gtm_pack import render_full_pack, render_pack_with_artifacts  # noqa: E402
from gtm_pack.sample_inputs import SAMPLE_INPUTS  # noqa: E402


@pytest.fixture(scope="module")
def out_dir(tmp_path_factory):
    return tmp_path_factory.mktemp("gtm_pack_out")


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_render_full_pack_produces_9_slides(theme, out_dir):
    pptx = render_full_pack(SAMPLE_INPUTS, theme, out_dir)
    assert pptx.exists()
    prs = Presentation(str(pptx))
    assert len(prs.slides) == 9, f"Expected 9 slides for {theme}, got {len(prs.slides)}"


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_no_residual_steam_refs(theme, out_dir):
    pptx = render_full_pack(SAMPLE_INPUTS, theme, out_dir)
    proc = subprocess.run(
        [sys.executable, "-m", "markitdown", str(pptx)],
        capture_output=True, text=True, timeout=60,
    )
    text = proc.stdout.lower()
    for forbidden in ("steam", "valve", "mad octopus", "steamworks", "aetheria"):
        assert forbidden not in text, f"Found forbidden '{forbidden}' in {theme} pack"


def test_render_pack_with_artifacts_produces_pdf_and_pngs(out_dir):
    """Full integration: PPTX + PDF + 9 PNGs."""
    result = render_pack_with_artifacts(SAMPLE_INPUTS, "dark", out_dir)
    assert result["pptx"].exists()
    assert result["pdf"].exists()
    assert len(result["pngs"]) == 9
    for png in result["pngs"]:
        assert png.exists()
        assert png.stat().st_size > 10_000  # at least 10KB each
