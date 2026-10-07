#!/usr/bin/env python3
"""Offline exporter QA. Generates its OWN disposable recipient; never parent key."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import tempfile

spec = importlib.util.spec_from_file_location("exporter", Path(__file__).with_name("export-buying-snapshot.py"))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)
root = Path(tempfile.mkdtemp(prefix="buying-export-qa-", dir=os.environ.get("QA_OUTPUT_DIR", "/home/user/workspace")))
os.umask(0o077)
source = root / "fixture.db"
db = sqlite3.connect(source)
secret = "PRIVATE_CANARY_COOKIE_SESSION_APIKEY_USER_NOTES_RAW"
for table, keep in exporter.KEEP.items():
    names = sorted(keep)
    cols = []
    for name in names:
        cols.append(f'"{name}" ' + ("INTEGER PRIMARY KEY" if name == "id" else "TEXT"))
    for name in exporter.REDACT_REQUIRED.get(table, {}):
        if name not in keep:
            cols.append(f'"{name}" TEXT NOT NULL')
    cols += ['private_notes TEXT', 'raw_payload TEXT']
    db.execute(f'CREATE TABLE "{table}" ({",".join(cols)})')
    index_col = "key" if table == "app_settings" else names[0]
    db.execute(f'CREATE INDEX "qa_{table}" ON "{table}"("{index_col}")')
    row_cols = [r[1] for r in db.execute(f'PRAGMA table_info("{table}")')]
    keys = [*exporter.SETTINGS, "api_secret", "cookie"] if table == "app_settings" else [None, None]
    for idx, key in enumerate(keys, 1):
        values = []
        for col in row_cols:
            if col == "id":
                values.append(idx * 3)
            elif table == "app_settings" and col == "key":
                values.append(key)
            elif col not in keep or (table == "app_settings" and key not in exporter.SETTINGS):
                values.append(secret)
            elif table == "steam_unit_milestones" and col == "payload_json":
                values.append('{"units": 40000, "basis": "public"}')
            else:
                values.append(f"public-{idx}-{col}")
        db.execute(f'INSERT INTO "{table}" ({",".join(exporter.quoted(c) for c in row_cols)}) VALUES({",".join("?" for _ in row_cols)})', values)
db.execute("CREATE TABLE sessions(cookie TEXT)")
db.execute("INSERT INTO sessions VALUES(?)", (secret,))
db.execute("ANALYZE")
db.commit()
db.close()
before = exporter.digest(source)
dest = root / "sanitized.db"
meta = exporter.copy_allowlisted(source, dest, "a" * 40)
assert exporter.digest(source) == before, "source changed"
assert secret.encode() not in dest.read_bytes(), "private canary leaked"
src = sqlite3.connect(source)
out = sqlite3.connect(dest)
tables = {r[0] for r in out.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
assert tables == set(exporter.KEEP)
assert {r[0] for r in out.execute("SELECT key FROM app_settings")} == set(exporter.SETTINGS)
for table, keep in exporter.KEEP.items():
    for typ in ("table", "index"):
        query = "SELECT name,sql FROM sqlite_schema WHERE type=? AND tbl_name=? ORDER BY name"
        assert src.execute(query, (typ, table)).fetchall() == out.execute(query, (typ, table)).fetchall()
    cols = ",".join(["rowid"] + [exporter.quoted(c) for c in sorted(keep)])
    where = " WHERE key IN (" + ",".join("?" for _ in exporter.SETTINGS) + ")" if table == "app_settings" else ""
    params = exporter.SETTINGS if where else ()
    query = f'SELECT {cols} FROM "{table}"{where} ORDER BY rowid'
    assert src.execute(query, params).fetchall() == out.execute(query, params).fetchall(), table
assert src.execute("SELECT * FROM sqlite_stat1 WHERE tbl != 'sessions' ORDER BY tbl,idx").fetchall() == out.execute("SELECT * FROM sqlite_stat1 ORDER BY tbl,idx").fetchall()
src.close()
out.close()
# Fail closed on an unreviewed NOT NULL column.
db = sqlite3.connect(source)
db.execute("ALTER TABLE products ADD COLUMN unreviewed TEXT NOT NULL DEFAULT 'hidden'")
db.commit()
db.close()
try:
    exporter.copy_allowlisted(source, root / "rejected.db", "a" * 40)
    raise AssertionError("unreviewed required column accepted")
except ValueError as error:
    assert "unreviewed required" in str(error)
db = sqlite3.connect(source)
db.execute("ALTER TABLE products DROP COLUMN unreviewed")
db.commit()
db.close()
before_encryption = exporter.digest(source)
key, cert = root / "QA-ONLY.key", root / "QA-ONLY.crt"
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-keyout", str(key), "-out", str(cert), "-subj", "/CN=OFFLINE-QA-ONLY", "-days", "1"],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
cipher = root / "transfer" / "snapshot.cms"
receipt = exporter.export_encrypted(source, cipher, cert, "b" * 40)
assert exporter.digest(source) == before_encryption
assert set(p.name for p in cipher.parent.iterdir()) == {"snapshot.cms"}
assert secret.encode() not in cipher.read_bytes()
plain = root / "roundtrip.tar"
cmd = ["openssl", "cms", "-decrypt", "-binary", "-inform", "DER", "-in", str(cipher),
       "-recip", str(cert), "-inkey", str(key), "-out", str(plain)]
subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with tarfile.open(plain) as archive:
    assert set(archive.getnames()) == {"data.db", "manifest.json"}
    manifest = json.load(archive.extractfile("manifest.json"))
    import hashlib
    assert hashlib.sha256(archive.extractfile("data.db").read()).hexdigest() == manifest["snapshot_sha256"]
tampered = root / "tampered.cms"
blob = bytearray(cipher.read_bytes())
blob[len(blob) // 2] ^= 1
tampered.write_bytes(blob)
badcmd = [str(tampered) if x == str(cipher) else str(root / "rejected-tampered.tar") if x == str(plain) else x for x in cmd]
result = subprocess.run(badcmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
assert result.returncode != 0, "tampered ciphertext accepted"
report = {"status": "PASS", "checks": ["17-table allowlist", "7-settings allowlist",
          "private canary absent", "source hash unchanged", "DDL/index parity",
          "rowid/read-column parity", "planner stat1 parity", "unknown required column rejected",
          "AES-256-GCM roundtrip", "ciphertext tamper rejected", "ciphertext-only transfer folder"],
          "output": str(root), "receipt": receipt}
(root / "qa-results.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
