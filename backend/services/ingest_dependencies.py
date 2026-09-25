"""Read-only checks before the early daily run. No service starts/stops."""
import logging
import sqlite3
import subprocess
import time
from contextlib import closing
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

log = logging.getLogger(__name__)
ET = ZoneInfo("America/New_York")


def _systemctl(*args):
    return subprocess.check_output(
        ["systemctl", *args], text=True, timeout=5).strip()


def dependency_blockers(*, check_youtube=True, now=None):
    now = now or datetime.now(ET)
    blockers = []
    try:
        state = _systemctl("show", "signalpulse-daily.service",
                           "--property=ActiveState", "--value")
        if state not in ("inactive", "failed"):
            blockers.append(f"SignalPulse storefront refresh state={state or 'unknown'}")
        if check_youtube:
            wd = _systemctl("show", "signalpulse.service",
                            "--property=WorkingDirectory", "--value")
            if not wd:
                raise RuntimeError("SignalPulse working directory unavailable")
            path = Path(wd) / "youtube.db"
            with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)) as db:
                running = db.execute(
                    "SELECT COUNT(*) FROM yt_ingest_runs WHERE status='running'"
                ).fetchone()[0]
                latest = db.execute(
                    "SELECT started_at, status FROM yt_ingest_runs "
                    "WHERE trigger='scheduled' ORDER BY id DESC LIMIT 1"
                ).fetchone()
            if running:
                blockers.append("YouTube collection is running")
            elif not latest or datetime.fromisoformat(
                latest[0].replace("Z", "+00:00")
            ).astimezone(ET).date() != now.astimezone(ET).date():
                blockers.append("YouTube has no scheduled run for today's Eastern date")
            elif latest[1] not in ("success", "partial"):
                blockers.append(f"YouTube scheduled run status={latest[1]}")
            elif latest[1] == "partial":
                log.warning("YouTube upstream is partial; importing available data, not claiming full coverage")
    except Exception as exc:
        blockers.append(f"Dependency check unavailable: {type(exc).__name__}: {exc}")
    return blockers


def wait_for_dependencies(*, timeout=3600, check_youtube=True):
    deadline = time.monotonic() + timeout
    while True:
        blockers = dependency_blockers(check_youtube=check_youtube)
        if not blockers:
            log.info("ingest dependencies ready")
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("Ingestion deferred beyond deadline: " + "; ".join(blockers))
        log.warning("ingest waiting for dependencies: %s", "; ".join(blockers))
        time.sleep(min(60, remaining))
