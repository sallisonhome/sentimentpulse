"""Operator-authorized demo-only population plus live API verification.

Run only through the existing GitHub Actions SSH transport. Credentials and
the short-lived, signalpulse-scoped diagnostic JWT stay in memory on the
droplet; never print them or persist them. No service/config/schema changes.
"""
import base64
import argparse
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
import urllib.parse
import uuid
from pathlib import Path
from datetime import datetime, timedelta, timezone


def signed_token(secret):
    encode = lambda value: base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()
    stamp = int(time.time())
    payload = encode({"alg": "HS256", "typ": "JWT"}) + "." + encode({
        "sub": "ops-demo-verification", "email": "ops-automation@internal",
        "scopes": ["signalpulse"], "is_admin": False,
        "jti": str(uuid.uuid4()), "iat": stamp, "exp": stamp + 1800,
    })
    signature = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    return payload + "." + signature


def request(path, headers=None, method="GET", timeout=30):
    req = urllib.request.Request(
        "http://127.0.0.1:5000" + path, headers=headers or {}, method=method
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        assert response.status == 200
        return json.load(response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--read-only", action="store_true",
                        help="Verify existing data without triggering ingestion")
    args = parser.parse_args()
    env = {}
    for line in Path("/etc/signalpulse/env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key] = value.strip().strip("'\"")
    assert env.get("INGESTION_OPS_TOKEN"), "Ops token missing"
    assert env.get("SABER_AUTH_JWT_SECRET"), "JWT secret missing"

    for path in ["/api/demos/leaderboard", "/api/ops/demos-portal-probe/5184670"]:
        try:
            request(path)
            raise AssertionError("Unauthenticated request was not rejected")
        except urllib.error.HTTPError as error:
            assert error.code == 401, f"Unexpected unauthenticated status: {error.code}"
    print("Unauthenticated leaderboard and probe: HTTP 401", flush=True)

    run = None
    if not args.read_only:
        result = request("/api/ops/demos-pipeline-run",
                         {"x-ops-token": env["INGESTION_OPS_TOKEN"]},
                         method="POST", timeout=900)
        print("DEMO_PIPELINE " + json.dumps(result), flush=True)
        run = result["result"]
        assert result["ok"] is True
        assert run["portalActualsFetch"]["status"] == "skipped"
        assert run["actuals"]["rowsWritten"] == 0
        assert run["reviewHistory"]["ingested"] > 0
        assert run["estimates"]["rowsWritten"] > 0
        assert all(feed["status"] == "success" for feed in run["discovery"]["feeds"])
    headers = {"Authorization": "Bearer " + signed_token(env["SABER_AUTH_JWT_SECRET"])}

    for window in ["d7", "d30", "d90", "m12", "ltd"]:
        for sort in ["top", "new", "downloads", "ccu", "reviews", "peak", "release"]:
            data = request(f"/api/demos/leaderboard?window={window}&sort={sort}&limit=50", headers)
            rows = data["demos"]
            assert rows and len(rows) <= 50
            assert data["window"] == window and data["sort"] == sort
            key = {"top": "sourceRank", "new": "sourceRank", "downloads": "unitsMid",
                   "ccu": "ccuCurrent", "reviews": "reviewCountTotal",
                   "peak": "ccuAllTimePeak", "release": "releaseDate"}[sort]
            values = [row[key] for row in rows if row[key] is not None]
            assert values == sorted(values, reverse=sort not in ("top", "new")), f"Sort failure: {window}/{sort}"
            for feed in data["coverage"]["feeds"]:
                assert feed["lastSuccessAt"] and not feed["error"]
                assert feed["candidateCount"] > 50, "Pagination coverage missing"
            for row in rows:
                assert row["method"] in (None, "review_delta_multiplier", "observed_ccu_lower_bound")
                if row["method"] == "observed_ccu_lower_bound":
                    assert row["isObservedMinimum"]
                    assert row["unitsMid"] == row["ccuAllTimePeak"]
                    assert row["reviewEstimate"] is None or row["unitsMid"] > row["reviewEstimate"]
                    assert row["unitsLow"] is None and row["unitsHigh"] is None
                    if window != "ltd":
                        cutoff = datetime.now(timezone.utc) - timedelta(days={"d7": 7, "d30": 30, "d90": 90, "m12": 365}[window])
                        assert datetime.fromisoformat(row["releaseDate"]).replace(tzinfo=timezone.utc) >= cutoff
                elif row["unitsMid"] is not None:
                    expected = int(row["reviewDelta"] * data["multiplier"]["mid"] + 0.5)
                    assert row["unitsMid"] == expected
                if row["ccuCurrent"] is not None:
                    assert row["ccuAsOf"] is not None
                    assert row["ccuAllTimePeak"] >= row["ccuCurrent"]
            print("LEADERBOARD " + json.dumps(data), flush=True)
    for sort, key in [("downloads", "unitsMid"), ("ccu", "ccuCurrent"),
                      ("reviews", "reviewCountTotal"), ("peak", "ccuAllTimePeak"),
                      ("release", "releaseDate")]:
        data = request(f"/api/demos/leaderboard?sort={sort}&direction=asc&limit=100", headers)
        values = [row[key] for row in data["demos"] if row[key] is not None]
        assert values == sorted(values)
        for genre in data["genres"]:
            filtered = request(f"/api/demos/leaderboard?sort={sort}&genre={urllib.parse.quote(genre)}", headers)
            assert all(genre in (row["genre"] or "").split(", ") for row in filtered["demos"])
    if run:
        for phase in ["discovery", "eligibility", "reviewHistory", "ccu"]:
            assert run[phase]["failed"] == 0, f"{phase} has failures; inspect DEMO_PIPELINE"
    print("VERIFIED: three feeds, five windows, seven sorts, both directions, genre filters, multiplier arithmetic", flush=True)


if __name__ == "__main__":
    main()
