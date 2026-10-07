#!/usr/bin/env python3
"""Synthetic-only scale fixture from an EMPTY sanitized current-schema database."""
import argparse
from datetime import date, timedelta
from pathlib import Path
import shutil
import sqlite3

p = argparse.ArgumentParser()
p.add_argument("--schema", required=True)
p.add_argument("--output", required=True)
p.add_argument("--families", type=int, default=300)
args = p.parse_args()
output = Path(args.output)
if output.exists():
    raise ValueError("Output must be new")
source = sqlite3.connect(f"file:{Path(args.schema).resolve()}?mode=ro", uri=True)
assert source.execute("SELECT COUNT(*) FROM platform_sku_map").fetchone()[0] == 0
source.close()
shutil.copyfile(args.schema, output)
db = sqlite3.connect(output)
stamp = "2026-10-07"
for i in range(args.families):
    name = f"Offline Fixture Adventure {i:05d}"
    ceilings = ["The Witcher 3: Wild Hunt", "Phasmophobia", "Valheim", "Black Myth: Wukong",
                "ARC Raiders", "Ready or Not", "Crusader Kings III", "Crimson Desert"]
    if 100 <= i < 108:
        name = ceilings[i - 100]
    released = "2026-08-15" if i % 3 == 0 else "2022-01-01"
    for platidx, platform in enumerate(("steam", "ps5", "xbox")):
        tid = 10000 + i * 3 + platidx
        sku = str(tid) if platform == "steam" else f"SKU{tid}"
        db.execute("""INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,
          business_model,msrp_usd_cents,refreshed_at,created_at) VALUES(?,?,?,'base','paid',5999,?,?)""",
                   (tid, platform, sku, stamp, stamp))
        db.execute("""INSERT INTO console_title_igdb(title_id,name,store_name,release_date,
          store_release_date,refreshed_at,created_at) VALUES(?,?,?,?,?,?,?)""",
                   (tid, name, name, released, released, stamp, stamp))
        if platform == "xbox":
            db.execute("INSERT INTO xbox_title_cache VALUES(?,?,NULL,'store',?,?,1)", (sku, name, stamp, stamp))
        for day in range(31):
            when = str(date(2026, 9, 7) + timedelta(days=day))
            db.execute("""INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,
              source_endpoint,rating_count,avg_rating,window_label,created_at)
              VALUES(?,?,?,'synthetic',?,4.5,'ltd',?)""", (tid, platform, when, 1000 + day * 5 + i, stamp))
            for window, units in (("d7", 700), ("d30", 3000), ("d90", 8000), ("m12", 14000), ("ltd", 20000 + day * 100)):
                if 100 <= i < 108 and window == "ltd" and platform == "steam":
                    units = 100_000_000 + day * 100
                db.execute("""INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,
                  signal_value,units_mid,owners_mid,method,created_at)
                  VALUES(?,?,?,?,?,?,?,'ltd_state:accumulator',?)""",
                           (tid, platform, window, when, 1000 + day * 5, units + i, units + i, stamp))
        if i < 30:
            db.execute("""INSERT INTO revenue_calibration_anchors(title_id,platform,window,as_of_date,
              actual_revenue_usd,actual_units,reference_msrp_usd_cents,sale_state,data_source,created_at)
              VALUES(?,?,'ltd','2026-09-14',1000000,25000,5999,'full_price','manual_anchor_verified_fixture',?)""", (tid, platform, stamp))
db.commit()
db.close()
print(f"Synthetic fixture: {args.families} families; {args.families*3} SKUs; no current production data")
