#!/usr/bin/env python3
"""Render the canonical example pack and copy PNGs into static_example/.

Run once at deploy time. The example viewer page (frontend) loads these
without ever touching the renderer or the database.

As of Phase 3 (GTM Phase 3+4), the example pack is a fully-populated
deck for a fictional game, "Blackwood Hollow" (psychological horror).
Data lives in gtm_pack/example_inputs.py (EXAMPLE_INPUTS) -- see that
module's docstring for the "this is dummy data" disclaimer.
The pack was previously 9 slides (pre-Revisions 1/3/4) using
gtm_pack/sample_inputs.py; that module is now used only by pytest
(tests/test_render_full_pack.py) and is left untouched.

v7.0 (2026-07-18 polish pass) made slide count dynamic (6-8 slides):
the USP and Commercial Risks sub-decks each split into 2 slides when
they carry 4-5 items (locked split rule: <=3 items = 1 slide, 4-5 items
= [3, remainder] = 2 slides). EXAMPLE_INPUTS currently carries 5 USPs +
5 risks, so this script currently produces 8 slides -- but the script
itself makes no assumption about the exact count; it copies however
many PNGs render_pack_with_artifacts returns.

Output:
  backend/static_example/dark/1.png  ...  N.png
  backend/static_example/light/1.png  ... N.png
  (N is dynamic, currently 8 -- see slide-count note above)
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

# Make the package importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gtm_pack import render_pack_with_artifacts  # noqa: E402
from gtm_pack.example_inputs import EXAMPLE_INPUTS  # noqa: E402


def main():
    backend_dir = Path(__file__).resolve().parent.parent
    static_dir = backend_dir / "static_example"

    for theme in ("dark", "light"):
        print(f"[seed] rendering {theme} theme...")
        theme_out = static_dir / theme
        theme_out.mkdir(parents=True, exist_ok=True)

        # Render to a temp dir, then copy/rename PNGs
        tmp_out = backend_dir / f"_seed_tmp_{theme}"
        tmp_out.mkdir(exist_ok=True)
        try:
            result = render_pack_with_artifacts(EXAMPLE_INPUTS, theme, tmp_out)
            n_pngs = len(result["pngs"])
            assert 6 <= n_pngs <= 8, f"Expected 6-8 PNGs, got {n_pngs}"

            # Clear old PNGs in destination
            for old in theme_out.glob("*.png"):
                old.unlink()

            # Copy as 1.png ... N.png (sorted order, N is dynamic -- 6-8)
            for i, png in enumerate(result["pngs"], start=1):
                shutil.copy2(png, theme_out / f"{i}.png")
                print(f"  {theme}/{i}.png  ({png.stat().st_size:,} bytes)")
            print(f"  [seed] {theme}: {n_pngs} slides rendered")
        finally:
            shutil.rmtree(tmp_out, ignore_errors=True)

    print(f"\n[seed] complete. Example PNGs at {static_dir}/")


if __name__ == "__main__":
    main()
