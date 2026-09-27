#!/usr/bin/env python3
"""Read-only SignalPulse health probe; run on the droplet via SSH stdin.

Never emits credentials, cookie previews, raw responses, or exception messages.
Exit zero means the check succeeded, NOT necessarily that Steam refresh did.
"""
import datetime as dt
import json
import re
import shlex
import sys
import urllib.error
import urllib.request
from pathlib import Path

ENDPOINT = "http://127.0.0.1:5000/api/steam/session"
ENV_PATH = Path("/etc/signalpulse/env")
MAX_BYTES = 65536


def load_token(text):
    """Parse only the required assignment; never execute the environment file."""
    values = []
    for line in text.splitlines():
        match = re.match(r"^\s*(?:export\s+)?INGESTION_OPS_TOKEN\s*=(.*)$", line)
        if not match:
            continue
        parts = shlex.split(match.group(1), comments=True, posix=True)
        if len(parts) != 1:
            raise ValueError("Invalid credential configuration")
        values.append(parts[0])
    if len(values) != 1 or not re.fullmatch(r"[A-Za-z0-9_.-]{16,4096}", values[0]):
        raise ValueError("Invalid credential configuration")
    return values[0]


def redact(text, token):
    text = text.replace(token, "[REDACTED]")
    # Remove entire URLs: errors can contain login query parameters or paths.
    text = re.sub(r"https?://[^\s<>\"']+", "[URL REDACTED]", text, flags=re.I)
    text = re.sub(
        r"(?i)\b(?:authorization|cookie|set-cookie|x-ops-token)\s*:\s*[^\r\n]+",
        "[CREDENTIAL HEADER REDACTED]", text,
    )
    text = re.sub(
        r"(?i)\b(?:steamRefresh_partner|steamLoginSecure|sessionid|access_token|"
        r"refresh_token|token|password|secret)\s*[=:]\s*[^\s;,]+",
        "[CREDENTIAL REDACTED]", text,
    )
    text = re.sub(r"\b[A-Za-z0-9_+/%=.-]{24,}\b", "[OPAQUE VALUE REDACTED]", text)
    # Output is a JSON artifact, not an executable shell or workflow annotation.
    return "".join(c if c >= " " else " " for c in text)[:2000]


def summarize(payload, token):
    if not isinstance(payload, dict):
        raise ValueError("Unexpected response contract")
    attempt = payload.get("autoRefreshLastAttemptAt")
    result = payload.get("autoRefreshLastResult")
    if attempt is not None:
        if not isinstance(attempt, str) or len(attempt) > 64:
            raise ValueError("Unexpected attempt timestamp")
        parsed = dt.datetime.fromisoformat(attempt.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Attempt timestamp needs a timezone")
    if result is not None and not isinstance(result, str):
        raise ValueError("Unexpected refresh result")
    status = (
        "no_attempt" if attempt is None else
        "refresh_failed" if result and result.startswith("error") else "healthy"
    )
    return {
        "status": status,
        "autoRefreshLastAttemptAt": attempt,
        "autoRefreshLastResult": redact(result, token) if result is not None else None,
    }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe(token, opener=None):
    # Explicitly ignore proxy environment variables; credentials stay loopback.
    opener = opener or urllib.request.build_opener(
        urllib.request.ProxyHandler({}), NoRedirect()
    )
    request = urllib.request.Request(
        ENDPOINT, method="GET",
        headers={"x-ops-token": token, "Accept": "application/json"},
    )
    with opener.open(request, timeout=15) as response:
        if response.status != 200:
            raise ValueError("Unexpected HTTP status")
        raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("Response exceeds limit")
        return summarize(json.loads(raw), token)


def main():
    base = {
        "schemaVersion": 1,
        "service": "signalpulse",
        "checkedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    try:
        token = load_token(ENV_PATH.read_text())
    except (OSError, ValueError):
        base.update(status="check_failed", checkError="Server ops credential unavailable or invalid")
    else:
        try:
            base.update(probe(token))
        except urllib.error.HTTPError as error:
            base.update(status="check_failed", checkError=f"Local endpoint returned HTTP {error.code}")
            error.close()
        except (urllib.error.URLError, OSError, TimeoutError):
            base.update(status="check_failed", checkError="Local SignalPulse endpoint unavailable")
        except (ValueError, UnicodeError):
            base.update(status="check_failed", checkError="Local endpoint response failed validation")
        except Exception:
            # Do not expose an unexpected exception's text or raw response.
            base.update(status="check_failed", checkError="Unexpected health-check failure")
    print(json.dumps(base, ensure_ascii=True))
    return 1 if base["status"] == "check_failed" else 0


if __name__ == "__main__":
    sys.exit(main())
