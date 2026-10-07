#!/usr/bin/env python3
"""Export an encrypted, allowlisted Buying-query SQLite snapshot. Never import the app.

Source is opened mode=ro + query_only inside ONE read transaction. Only the
destination file receives DDL/inserts. No source backup/VACUUM/ANALYZE is used.
The output directory receives ONLY CMS ciphertext, never a plaintext database.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tarfile
import tempfile
import time
from datetime import datetime, timezone


SETTINGS = (
    "asp_factor_steam", "asp_factor_ps5", "asp_factor_xbox",
    "daily_gap_allocation_enabled", "launch_daily_reconstruction_enabled",
    "revenue_mix_mode", "revenue_mix_daily_mode",
)
# Explicit read-column policy. Everything else is blanked or rejected.
# Retaining original DDL/indexes is intentional: CTAS changes the query plan.
KEEP = {
    "platform_sku_map": "id title_id platform external_sku concept_id sku_role business_model msrp_usd_cents business_model_source is_manual_override is_gamepass refreshed_at created_at",
    "console_title_igdb": "title_id name release_date cover_url refreshed_at created_at store_name store_header_image_url match_confidence store_release_date",
    "xbox_title_cache": "big_id name art_url source first_landed_at last_verified_at verified_count",
    "store_rating_signal_daily": "id title_id platform capture_date rating_count avg_rating window_label is_native_window sku_count created_at",
    "window_estimates_daily": "id title_id platform window as_of_date signal_value owners_low owners_mid owners_high units_mid multiplier_id gated_reason method created_at",
    "revenue_calibration_anchors": "id title_id platform window as_of_date actual_revenue_usd actual_units reference_msrp_usd_cents sale_state implied_asp_pct_msrp rolling_asp_median_pct_msrp data_source created_at",
    "title_multiplier_overrides": "id title_id platform multiplier ci_pct digital_unit_share confidence method effective_from created_at",
    "products": "id steam_app_id",
    "steam_review_history": "id app_id bucket_start bucket_granularity recommendations_up recommendations_down created_at",
    "steam_unit_milestones": "id app_id title_id as_of_date payload_json active created_at",
    "steam_unit_calibration_daily": "milestone_id date signal units basis observed_at",
    "ownership_multipliers": "id platform cohort_key multiplier ci_pct digital_unit_share confidence method gp_rating_deflator effective_from created_at",
    "console_storefront_rank_daily": "platform sort_key snapshot_date title_id rank snapshot_at",
    "console_chart_rank_deep_daily": "platform sort_key snapshot_date raw_position paid_rank external_sku name business_model msrp_usd_cents captured_at",
    "revenue_mix_daily": "family_key date version signature result_json baseline_revenue_json delta_json applied",
    "revenue_mix_daily_runs": "date version completed_at mode families adjusted",
    "app_settings": "id key value created_at updated_at",
}
KEEP = {table: set(columns.split()) for table, columns in KEEP.items()}
# Required fields not read by a board; preserve constraints without copying data.
REDACT_REQUIRED = {
    "products": {
        "title": "snapshot-redacted", "publisher": "snapshot-redacted",
        "platforms": "[]", "player_format": "", "genre": "", "release_date": "",
        "is_saber_published": 0, "forecast_mode": "manual",
        "created_at": "", "updated_at": "",
    },
    "store_rating_signal_daily": {"source_endpoint": ""},
    "steam_review_history": {"source_endpoint": ""},
    "revenue_mix_daily": {"evidence_json": "{}"},
    "app_settings": {"label": "snapshot-redacted", "category": "snapshot", "is_secret": 0},
}
MODE_FLAGS = (
    "FC26_RECENT_FAMILY_ENABLED", "DAILY_GAP_ALLOCATION_ENABLED",
    "LAUNCH_DAILY_RECONSTRUCTION_ENABLED", "STEAM_UNIT_CALIBRATION_ENABLED",
)


def quoted(name):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise ValueError("unsupported schema identifier")
    return '"' + name + '"'


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def effective_modes(pid=None):
    """Emit ONLY semantic enum/boolean values, never arbitrary env strings."""
    if pid:
        with open(f"/proc/{pid}/environ", "rb") as file:
            entries = file.read().split(b"\0")
        wanted = set(MODE_FLAGS) | {"CHART_CONSISTENCY_MODE"}
        values = {}
        for entry in entries:
            key, sep, value = entry.partition(b"=")
            if sep and key.decode(errors="replace") in wanted:
                values[key.decode()] = value.decode(errors="replace")
    else:
        values = os.environ
    chart = values.get("CHART_CONSISTENCY_MODE", "report").lower()
    return {
        "CHART_CONSISTENCY_MODE": chart if chart in ("off", "enforce") else "report",
        **{flag: "0" if values.get(flag) == "0" else "1" for flag in MODE_FLAGS},
    }


def copy_allowlisted(source_path, destination, source_revision, service_pid=None,
                     max_seconds=120, max_bytes=1024 * 1024 * 1024):
    if not re.fullmatch(r"[a-fA-F0-9]{7,40}", source_revision):
        raise ValueError("source revision must be a Git SHA")
    source_path = Path(source_path).resolve(strict=True)
    destination = Path(destination).resolve()
    if destination.exists() or source_path == destination:
        raise ValueError("destination must be a new file")
    started = time.monotonic()
    src = sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True, timeout=1)
    # Defense-in-depth: forbid SQLite write operations even if mode=ro regresses.
    writes = {getattr(sqlite3, name) for name in (
        "SQLITE_INSERT", "SQLITE_UPDATE", "SQLITE_DELETE", "SQLITE_CREATE_TABLE",
        "SQLITE_CREATE_INDEX", "SQLITE_DROP_TABLE", "SQLITE_DROP_INDEX",
        "SQLITE_ALTER_TABLE", "SQLITE_ATTACH", "SQLITE_DETACH",
        "SQLITE_CREATE_TRIGGER", "SQLITE_DROP_TRIGGER", "SQLITE_CREATE_VIEW",
        "SQLITE_DROP_VIEW",
    )}
    src.execute("PRAGMA query_only=ON")
    src.set_authorizer(lambda action, *_: sqlite3.SQLITE_DENY if action in writes else sqlite3.SQLITE_OK)
    src.set_progress_handler(lambda: int(time.monotonic() - started > max_seconds), 10000)
    out = None
    try:
        src.execute("BEGIN")
        # This read establishes one SQLite snapshot for all tables and metadata.
        schema = src.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid"
        ).fetchall()
        tables = {name: ddl for typ, name, _, ddl in schema if typ == "table"}
        missing = set(KEEP) - set(tables)
        if missing:
            raise ValueError("required board tables missing: " + ",".join(sorted(missing)))
        modes = effective_modes(service_pid)
        metadata = {
            "format": "buying-query-snapshot-v1",
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "source_revision": source_revision,
            "sqlite_version": src.execute("SELECT sqlite_version()").fetchone()[0],
            "source_journal_mode": src.execute("PRAGMA journal_mode").fetchone()[0],
            "source_user_version": src.execute("PRAGMA user_version").fetchone()[0],
            "effective_modes": modes,
            "settings_allowlist": list(SETTINGS),
            "tables": {},
            "note": "Commercial/model data; encrypted private profiling only. No estimator or startup writer run.",
        }
        out = sqlite3.connect(destination)
        out.set_progress_handler(lambda: int(time.monotonic() - started > max_seconds), 10000)
        out.execute("PRAGMA foreign_keys=OFF")
        out.execute("PRAGMA journal_mode=DELETE")
        out.execute("BEGIN")
        for table, keep in KEEP.items():
            ddl = tables[table]
            if not re.match(r"CREATE\s+TABLE\b", ddl, re.I):
                raise ValueError("unsupported table DDL")
            # No application hooks, triggers, views or virtual tables are copied.
            out.execute(ddl)
            info = src.execute(f"PRAGMA table_info({quoted(table)})").fetchall()
            cols = [r[1] for r in info]
            absent = keep - set(cols)
            if absent:
                raise ValueError("required board columns missing in " + table + ": " + ",".join(sorted(absent)))
            has_rowid = not re.search(r"\bWITHOUT\s+ROWID\b", ddl, re.I)
            select = []
            for _, name, _, not_null, _, pk in info:
                if name in keep:
                    select.append(quoted(name))
                elif name in REDACT_REQUIRED.get(table, {}):
                    # Binding redactions prevents reading an excluded source column at all.
                    select.append("?")
                elif not_null or pk:
                    raise ValueError("unreviewed required source column in " + table + "." + name)
                else:
                    select.append("NULL")
            redactions = [REDACT_REQUIRED[table][r[1]] for r in info
                          if r[1] not in keep and r[1] in REDACT_REQUIRED.get(table, {})]
            prefix = "rowid," if has_rowid else ""
            where = ""
            binds = list(redactions)
            if table == "app_settings":
                where = " WHERE key IN (" + ",".join("?" for _ in SETTINGS) + ")"
                binds.extend(SETTINGS)
            order = "rowid" if has_rowid else ",".join(quoted(r[1]) for r in sorted(info, key=lambda r: r[5]) if r[5])
            cursor = src.execute(f"SELECT {prefix}{','.join(select)} FROM {quoted(table)}{where} ORDER BY {order}", binds)
            names = (["rowid"] if has_rowid else []) + cols
            insert = f"INSERT INTO {quoted(table)}({','.join(quoted(c) for c in names)}) VALUES({','.join('?' for _ in names)})"
            count = 0
            while True:
                rows = cursor.fetchmany(1000)
                if not rows:
                    break
                if time.monotonic() - started > max_seconds:
                    raise TimeoutError("snapshot elapsed-time safety bound")
                out.executemany(insert, rows)
                count += len(rows)
                if destination.stat().st_size > max_bytes:
                    raise ValueError("snapshot size safety bound")
            indexes = [sql for typ, _, owner, sql in schema if typ == "index" and owner == table]
            for index in indexes:
                out.execute(index)
            metadata["tables"][table] = {
                "rows": count, "ddl": ddl, "indexes": indexes,
                "kept_columns": sorted(keep),
                "redacted_columns": sorted(set(cols) - keep),
            }
        # Keep existing planner statistics only for included tables/indexes.
        # ANALYZE here touches ONLY the newly created destination, not the source.
        if "sqlite_stat1" in tables:
            out.execute("ANALYZE sqlite_schema")
            stats = src.execute(
                "SELECT tbl,idx,stat FROM sqlite_stat1 WHERE tbl IN (" +
                ",".join("?" for _ in KEEP) + ")", list(KEEP)
            ).fetchall()
            out.executemany("INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES(?,?,?)", stats)
            metadata["planner_stat1_rows"] = len(stats)
        else:
            metadata["planner_stat1_rows"] = 0
        metadata["source_has_stat4"] = "sqlite_stat4" in tables
        metadata["stat4_note"] = "If true, compare runtime SQLite build/statistics before claiming exact production planner parity."
        metadata["planner_parity_note"] = (
            "Original DDL/indexes/rowids/stat1 preserved, but sanitized unused columns, "
            "different physical page layout and Python vs application SQLite builds can "
            "affect plans. Export is not proof of exact production planner parity."
        )
        src.execute("ROLLBACK")
        out.commit()
        if time.monotonic() - started > max_seconds:
            raise TimeoutError("snapshot elapsed-time safety bound after indexes/commit")
        if destination.stat().st_size > max_bytes:
            raise ValueError("snapshot size safety bound after indexes/commit")
        if out.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("destination integrity check failed")
        if time.monotonic() - started > max_seconds:
            raise TimeoutError("snapshot elapsed-time safety bound after integrity check")
        out.close()
        out = None
        metadata["snapshot_sha256"] = digest(destination)
        metadata["snapshot_bytes"] = destination.stat().st_size
        return metadata
    finally:
        if out is not None:
            out.close()
        src.close()


def export_encrypted(db, output, cert, revision, service_pid=None,
                     max_seconds=120, max_bytes=1024 * 1024 * 1024, runtime_info=None):
    output = Path(output).resolve()
    if output.exists():
        raise ValueError("output must not already exist")
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    cert = Path(cert).resolve(strict=True)
    # Validate certificate BEFORE reading any production rows.
    subprocess.run(["openssl", "x509", "-in", str(cert), "-noout"], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with tempfile.TemporaryDirectory(prefix="buying-snapshot-") as tmp:
        root = Path(tmp)
        # Check remote OpenSSL GCM support BEFORE opening source database.
        probe = root / "crypto-probe"
        probe.write_bytes(b"buying-snapshot-encryption-preflight")
        subprocess.run(["openssl", "cms", "-encrypt", "-binary", "-aes-256-gcm",
                        "-in", str(probe), "-outform", "DER", "-out", str(root / "probe.cms"), str(cert)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        runtime = None
        if runtime_info:
            raw = json.loads(Path(runtime_info).read_text())
            runtime = {key: raw[key] for key in ("node", "better_sqlite3", "sqlite")}
            if not all(isinstance(v, str) and re.fullmatch(r"v?[0-9]+(?:\.[0-9]+){1,3}", v) for v in runtime.values()):
                raise ValueError("invalid runtime version metadata")
        metadata = copy_allowlisted(db, root / "data.db", revision, service_pid, max_seconds, max_bytes)
        metadata["application_runtime_versions"] = runtime
        (root / "manifest.json").write_text(json.dumps(metadata, indent=2), encoding="utf8")
        with tarfile.open(root / "bundle.tar", "w") as archive:
            archive.add(root / "data.db", arcname="data.db")
            archive.add(root / "manifest.json", arcname="manifest.json")
        partial = root / "snapshot.cms"
        subprocess.run([
            "openssl", "cms", "-encrypt", "-binary", "-aes-256-gcm",
            "-in", str(root / "bundle.tar"), "-outform", "DER", "-out", str(partial),
            str(cert),
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # Publish ciphertext only after encryption completed successfully.
        with partial.open("rb") as inp, output.open("xb") as dest:
            for chunk in iter(lambda: inp.read(1024 * 1024), b""):
                dest.write(chunk)
        os.chmod(output, 0o600)
    return {"tables": len(KEEP), "ciphertext_bytes": output.stat().st_size,
            "ciphertext_sha256": digest(output)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--certificate", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--service-pid", type=int)
    parser.add_argument("--max-seconds", type=int, default=120)
    parser.add_argument("--max-bytes", type=int, default=1024 * 1024 * 1024)
    parser.add_argument("--runtime-info")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        receipt = export_encrypted(args.db, args.output, args.certificate,
                                   args.source_revision, args.service_pid,
                                   args.max_seconds, args.max_bytes, args.runtime_info)
    except Exception as error:
        # Errors must not print row content, environment values or private paths.
        print("Snapshot failed: " + type(error).__name__, file=__import__("sys").stderr)
        raise SystemExit(1)
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
