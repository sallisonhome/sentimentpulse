"""Reproducibly transform reviewed local research outputs into a typed snapshot.

Usage: python scripts/import-pass-scenario-snapshot.py /home/user/workspace/pass_backtest/outputs
No APIs, credentials, database writes or model fitting.
"""
import csv
import calendar
import hashlib
import json
from pathlib import Path
import sys

source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]/"docs/pass-scenario-inputs"
inputs = ["qualified_pass_usage_inputs.csv", "qualified_input_assumptions.json",
          "lords_post_event_scenarios.csv"]
blobs = {name: (source/name).read_bytes() for name in inputs}
sha = hashlib.sha256(b"".join(blobs[name] for name in inputs)).hexdigest()
rows = list(csv.DictReader(blobs[inputs[0]].decode().splitlines()))
assumptions = json.loads(blobs[inputs[1]])
models = list(csv.DictReader(blobs[inputs[2]].decode().splitlines()))
selected = {r["month"][:7]: r for r in models if r["model"] == "last"}
out = {"snapshotDate": "2026-09-26", "sourceSha256": sha,
       "methodVersion": "qualified_planning_v1",
       "historicalShare": assumptions["it_takes_two"]["central_share"],
       "historicalLow": assumptions["it_takes_two"]["sensitivity_low_share"],
       "historicalHigh": assumptions["it_takes_two"]["sensitivity_high_share"],
       "rows": []}
for r in rows:
    assert r["title"] in {"Lords of the Fallen", "It Takes Two"}
    lords = r["title"] == "Lords of the Fallen"
    assert r["observed"] == "False" and r["production_enabled"] == "False"
    observed = float(r["observed_game_runtime_avg_ccu"])
    year, month = map(int, r["month"][:7].split("-"))
    assert float(r["month_hours"]) == calendar.monthrange(year, month)[1]*24
    excess = float(selected[r["month"][:7]]["signed_excess_ccu"]) if lords else None
    out["rows"].append({
        "title": "lords" if lords else "it-takes-two", "month": r["month"][:7],
        "hours": float(r["month_hours"]), "observedRuntimeAvgCcu": observed,
        "observedLegacyAvgCcu": None if lords else float(r["observed_legacy_pass_avg_ccu"]),
        "denominatorAvgCcu": float(r["denominator_ccu"]),
        "baselineAvgCcu": observed-excess if lords else None,
        "broadHighAvgCcu": float(r["sensitivity_high"]),
    })
assert len({(r["title"], r["month"]) for r in out["rows"]}) == len(out["rows"])
for title, expected_count in [("lords",16),("it-takes-two",27)]:
    month_ids = [int(r["month"][:4])*12+int(r["month"][5:7]) for r in out["rows"] if r["title"]==title]
    assert len(month_ids)==expected_count
    assert sorted(month_ids)==list(range(min(month_ids),max(month_ids)+1))
target = Path(__file__).resolve().parents[1]/"server/signals/demos/pass-scenario-snapshot.ts"
target.write_text("// Generated from reviewed research CSVs; do not hand-edit. No live data fetch.\n"
                  + "export const PASS_SCENARIO_SNAPSHOT = "
                  + json.dumps(out, indent=2) + " as const;\n")
print(f"Generated {len(out['rows'])} source months; SHA-256 {sha}")
