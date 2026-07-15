#!/usr/bin/env python3
"""Render the canonical example pack and copy PNGs into static_example/.

Run once at deploy time. The example viewer page (frontend) loads these
without ever touching the renderer or the database.

As of Phase 3 (GTM Phase 3+4), the example pack is a fully-populated
12-slide deck for a fictional game, "Blackwood Hollow" (psychological
horror). Data lives in gtm_pack/example_inputs.py (EXAMPLE_INPUTS) --
see that module's docstring for the "this is dummy data" disclaimer.
The pack was previously 9 slides (pre-Revisions 1/3/4) using
gtm_pack/sample_inputs.py; that module is now used only by pytest
(tests/test_render_full_pack.py) and is left untouched.

Output:
  backend/static_example/dark/1.png  ...  12.png
  backend/static_example/light/1.png  ... 12.png
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
            assert len(result["pngs"]) == 12, f"Expected 12 PNGs, got {len(result['pngs'])}"

            # Clear old PNGs in destination
            for old in theme_out.glob("*.png"):
                old.unlink()

            # Copy as 1.png ... 9.png (sorted order)
            for i, png in enumerate(result["pngs"], start=1):
                shutil.copy2(png, theme_out / f"{i}.png")
                print(f"  {theme}/{i}.png  ({png.stat().st_size:,} bytes)")
        finally:
            shutil.rmtree(tmp_out, ignore_errors=True)

    print(f"\n[seed] complete. Example PNGs at {static_dir}/")


if __name__ == "__main__":
    main()
