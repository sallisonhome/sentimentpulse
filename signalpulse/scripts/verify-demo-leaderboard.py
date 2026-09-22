"""Operator-authorized demo-only population plus live API verification.

Run only through the existing GitHub Actions SSH transport. Credentials and
the short-lived, signalpulse-scoped diagnostic JWT stay in memory on the
droplet; never print them or persist them. No service/config/schema changes.
"""
import base64
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


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
    headers = {"Authorization": "Bearer " + signed_token(env["SABER_AUTH_JWT_SECRET"])}

    for window in ["d7", "d30", "d90", "m12", "ltd"]:
        for sort in ["downloads", "ccu"]:
            data = request(f"/api/demos/leaderboard?window={window}&sort={sort}&limit=50", headers)
            rows = data["demos"]
            assert rows and len(rows) <= 50
            assert data["window"] == window and data["sort"] == sort
            key = "unitsMid" if sort == "downloads" else "ccuCurrent"
            values = [row[key] for row in rows if row[key] is not None]
            assert values == sorted(values, reverse=True), f"Sort failure: {window}/{sort}"
            for row in rows:
                assert row["method"] in (None, "review_delta_multiplier")
                if row["unitsMid"] is not None:
                    expected = int(row["reviewDelta"] * data["multiplier"]["mid"] + 0.5)
                    assert row["unitsMid"] == expected
                if row["ccuCurrent"] is not None:
                    assert row["ccuAsOf"] is not None
                    assert row["ccuAllTimePeak"] >= row["ccuCurrent"]
            print("LEADERBOARD " + json.dumps(data), flush=True)
    for phase in ["discovery", "eligibility", "reviewHistory", "ccu"]:
        assert run[phase]["failed"] == 0, f"{phase} has failures; inspect DEMO_PIPELINE"
    print("VERIFIED: five windows, two sorts, multiplier arithmetic, sample timestamps, no actuals", flush=True)


if __name__ == "__main__":
    main()
