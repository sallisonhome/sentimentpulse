"""
Cron-hardening: retry helper + fail-alert email.

Shared by the in-process APScheduler jobs (backend/scheduler.py) and by
GitHub Actions cron workflows that shell in via SSH. The GitHub side
invokes this module through `python -m services.cron_alerts alert ...`
so the alert payload builds the same way from both entry points.

Rules
-----
* Retries: attempt the job up to 4 times (1 initial + 3 retries) with
  5-, 15-, 60-minute backoff between attempts.
  Backoff is per-attempt sleep in seconds; the caller passes a callable
  and this module invokes it. Any exception from the callable counts as
  a retriable failure; a non-True/None return counts as success only if
  the callable declares itself successful (default: exception-free means
  ok). If all 3 attempts fail, an alert email is sent and the last
  exception is re-raised so the outer surface (systemd unit or GH run)
  shows red.
* Alerts: single Resend HTTPS POST to sallisonhome@yahoo.com with the
  cron name, attempt count, last error, and a short tail of stdout/stderr
  when available. Non-blocking to the retry loop: if the alert send
  itself fails, we log and move on — the outer failure is still the
  source of truth.

DO NOT import this from anywhere in the request path — its only callers
are the scheduler and the workflows.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

# Backoff schedule in seconds. Deliberately long tail — the crons are
# daily jobs, so an extra hour of wall-clock delay to survive a flaky
# upstream is preferable to a false-red run.
_BACKOFF_SECONDS = (5 * 60, 15 * 60, 60 * 60)  # 5m, 15m, 60m

# Alert-mail defaults. Overridable via env to swap operator without a
# code push.
_ALERT_TO = os.getenv("CRON_ALERT_TO", "sallisonhome@yahoo.com")
_ALERT_FROM = os.getenv(
    "CRON_ALERT_FROM",
    # NB: uses the same verified sender the digest emails use.
    "SentimentPulse Ops <onboarding@resend.dev>",
)

_RESEND_URL = "https://api.resend.com/emails"
_RESEND_TIMEOUT = 20


# ── Public API ────────────────────────────────────────────────────────

def run_with_retry(
    job_name: str,
    job: Callable[[int], Any],
    *,
    max_attempts: int = 4,
    on_success: Optional[Callable[[int, Any], None]] = None,
) -> Any:
    """
    Invoke `job(attempt)` (1-indexed) up to `max_attempts` times.

    Retries only on Exception. Backoff between attempts follows
    _BACKOFF_SECONDS (5m / 15m / 60m). On final failure, sends an alert
    email and re-raises the last exception so the outer surface shows
    red. On success calls `on_success(attempt, result)` if provided.

    Returns the successful call's return value.
    """
    attempts = min(max_attempts, len(_BACKOFF_SECONDS) + 1)
    last_exc: Optional[BaseException] = None
    last_tb: str = ""

    for attempt in range(1, attempts + 1):
        try:
            logger.info("cron[%s] attempt %d/%d starting", job_name, attempt, attempts)
            result = job(attempt)
            logger.info("cron[%s] attempt %d/%d succeeded", job_name, attempt, attempts)
            if on_success is not None:
                try:
                    on_success(attempt, result)
                except Exception:
                    logger.exception("cron[%s] on_success callback raised", job_name)
            return result
        except Exception as exc:  # noqa: BLE001 — intentional catch-all
            last_exc = exc
            last_tb = traceback.format_exc()
            logger.exception(
                "cron[%s] attempt %d/%d failed: %s", job_name, attempt, attempts, exc,
            )
            if attempt < attempts:
                sleep_s = _BACKOFF_SECONDS[attempt - 1]
                logger.warning(
                    "cron[%s] retrying in %d seconds", job_name, sleep_s,
                )
                time.sleep(sleep_s)

    # All attempts exhausted — alert then re-raise.
    _send_alert_safe(
        job_name=job_name,
        attempts=attempts,
        last_error=str(last_exc) if last_exc else "unknown",
        traceback_text=last_tb,
        extra_lines=None,
    )
    assert last_exc is not None  # for the type checker
    raise last_exc


def send_failure_alert(
    job_name: str,
    *,
    attempts: int,
    last_error: str,
    extra_lines: Optional[list[str]] = None,
) -> dict:
    """
    Standalone alert used by GH Actions workflows (see the CLI below).
    Never raises. Returns the send outcome dict.
    """
    return _send_alert_safe(
        job_name=job_name,
        attempts=attempts,
        last_error=last_error,
        traceback_text="",
        extra_lines=extra_lines or [],
    )


# ── Internals ─────────────────────────────────────────────────────────

def _send_alert_safe(
    *,
    job_name: str,
    attempts: int,
    last_error: str,
    traceback_text: str,
    extra_lines: Optional[list[str]],
) -> dict:
    """Send an alert email. Never raises."""
    try:
        return _send_alert(
            job_name=job_name,
            attempts=attempts,
            last_error=last_error,
            traceback_text=traceback_text,
            extra_lines=extra_lines or [],
        )
    except Exception:
        logger.exception("cron alert send itself failed for %s", job_name)
        return {"sent": False, "reason": "alert_send_raised"}


def _send_alert(
    *,
    job_name: str,
    attempts: int,
    last_error: str,
    traceback_text: str,
    extra_lines: list[str],
) -> dict:
    api_key = os.getenv("RESEND_API_KEY")
    if not api_key:
        logger.warning("cron alert not sent: RESEND_API_KEY unset")
        return {"sent": False, "reason": "resend_not_configured"}

    now_utc = datetime.now(tz=timezone.utc).isoformat(timespec="seconds")
    subject = f"[SP cron alert] {job_name} failed after {attempts} attempts"
    html = _render_html(
        job_name=job_name, attempts=attempts, last_error=last_error,
        traceback_text=traceback_text, extra_lines=extra_lines, now_utc=now_utc,
    )
    body = json.dumps({
        "from": _ALERT_FROM,
        "to": [_ALERT_TO],
        "subject": subject,
        "html": html,
    }).encode("utf-8")
    req = urllib.request.Request(
        _RESEND_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            # Resend's Cloudflare edge 403s the default Python UA (see
            # services/digest_service.py comment). This UA passes.
            "User-Agent": "SentimentPulse/1.0 (+https://github.com/sallisonhome/sentimentpulse)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_RESEND_TIMEOUT) as resp:
            logger.info("cron alert sent for %s (status=%d)", job_name, resp.status)
            return {"sent": True, "status": resp.status}
    except urllib.error.HTTPError as e:
        text = (e.read(300) or b"").decode("utf-8", errors="replace")
        logger.error("cron alert HTTPError %d: %s", e.code, text)
        return {"sent": False, "status": e.code, "body": text}
    except Exception as e:  # noqa: BLE001
        logger.exception("cron alert network error: %s", e)
        return {"sent": False, "reason": "network_error", "error": str(e)}


def _render_html(
    *,
    job_name: str,
    attempts: int,
    last_error: str,
    traceback_text: str,
    extra_lines: list[str],
    now_utc: str,
) -> str:
    """Small readable HTML. Nothing fancy."""
    import html as html_lib
    def esc(s: str) -> str: return html_lib.escape(s or "")
    tb_block = ""
    if traceback_text:
        tb_block = (
            f"<h3 style='margin:16px 0 6px 0;font-size:13px'>Traceback</h3>"
            f"<pre style='background:#0b0f14;color:#d1d5db;padding:10px;"
            f"font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;"
            f"border-radius:6px;overflow:auto;max-width:640px'>{esc(traceback_text)}</pre>"
        )
    extra_block = ""
    if extra_lines:
        joined = "\n".join(extra_lines)
        extra_block = (
            f"<h3 style='margin:16px 0 6px 0;font-size:13px'>Context</h3>"
            f"<pre style='background:#f4f4f5;padding:10px;"
            f"font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;"
            f"border-radius:6px;overflow:auto;max-width:640px'>{esc(joined)}</pre>"
        )
    return f"""
<div style='font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:680px'>
  <h2 style='margin:0 0 10px 0'>SignalPulse cron alert</h2>
  <div style='color:#374151;margin-bottom:14px'>
    <b>Job:</b> {esc(job_name)}<br>
    <b>Attempts:</b> {attempts}<br>
    <b>At (UTC):</b> {esc(now_utc)}<br>
  </div>
  <div style='background:#fef2f2;border-left:3px solid #dc2626;padding:10px 12px;border-radius:4px'>
    <div style='font-size:12px;color:#991b1b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px'>Last error</div>
    <div style='font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#7f1d1d;white-space:pre-wrap'>{esc(last_error)}</div>
  </div>
  {extra_block}
  {tb_block}
  <p style='color:#6b7280;margin-top:18px;font-size:12px'>
    Sent by services/cron_alerts.py. To reroute this email, set
    <code>CRON_ALERT_TO</code> in /etc/sentimentpulse/env.
  </p>
</div>"""


# ── CLI entry point (used by GH Actions workflows) ────────────────────
#
# Usage:
#   python -m services.cron_alerts alert \\
#       --job "sp-cron-canary" \\
#       --attempts 3 \\
#       --error "canary FAIL: source 'bluesky' has ZERO writes today" \\
#       [--extra-file /tmp/canary.log]
#
# Exits 0 on any outcome (alert send is best-effort; the caller has
# already decided it's failing and does not want the alert branch to
# mask the original red exit).

def _main(argv: list[str]) -> int:
    import argparse
    p = argparse.ArgumentParser(prog="cron_alerts")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("alert")
    a.add_argument("--job", required=True)
    a.add_argument("--attempts", type=int, default=1)
    a.add_argument("--error", required=True)
    a.add_argument("--extra-file", default=None,
                   help="Optional path to a text file appended as Context")
    args = p.parse_args(argv)

    extra_lines: list[str] = []
    if args.extra_file:
        try:
            with open(args.extra_file, "r", encoding="utf-8", errors="replace") as f:
                # Last ~120 lines is usually enough context in a workflow log.
                extra_lines = f.read().splitlines()[-120:]
        except Exception as exc:  # noqa: BLE001
            extra_lines = [f"(failed to read {args.extra_file}: {exc})"]

    out = send_failure_alert(
        job_name=args.job,
        attempts=args.attempts,
        last_error=args.error,
        extra_lines=extra_lines,
    )
    print(json.dumps(out))
    # Return 0 regardless — the alert path is auxiliary.
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
