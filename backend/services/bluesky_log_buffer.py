"""In-memory ring buffer for ingest-source log records.

Why this exists:
  When the daily ingestion runs in a FastAPI BackgroundTasks worker, any
  WARNING / INFO / ERROR emitted by bluesky_service.py, arctic_shift_service.py,
  reddit_service.py, or steam_service.py is sent to the root logger (and
  ultimately journalctl).  The agent that operates this app cannot SSH to the
  droplet to read journalctl, so we mirror those records into an in-process
  ring buffer and expose them via /api/ingest/diag/bluesky and /api/ingest/diag/sources.

Historical note:
  This module was originally named bluesky_log_buffer because it was created
  to debug a Bluesky-only ingestion bug.  The module name is preserved for
  backwards compatibility, but the buffer now captures every ingest source
  service so the same diagnostic pattern can find silent failures in
  Reddit/Arctic Shift/Steam too.

Design:
  - Single module-level `collections.deque(maxlen=800)` of formatted strings.
  - Thread-safe (deque is atomic for append, but we also lock the snapshot
    function so a reader sees a consistent view).
  - A `RingBufferHandler` subclass of logging.Handler is attached exactly once
    to each watched logger via install_buffer().
  - Idempotent: re-installing does not double-attach.

Privacy:
  This buffer mirrors what those modules already log.  They are careful to
  NEVER log JWTs, passwords, or auth tokens; they log handle (effectively
  public), HTTP status codes, post counts, and exception classes.  The
  buffer simply preserves those records.
"""
from __future__ import annotations

import logging
import threading
from collections import deque
from datetime import datetime, timezone
from typing import Deque, List


# All ingest source loggers we mirror.  Adding a new source means adding its
# logger name here — nothing else.
_LOG_NAMES = (
    "services.bluesky_service",
    "services.arctic_shift_service",
    "services.reddit_service",
    "services.steam_service",
)
# Backwards-compat single-name constant (the original bluesky-only logger).
_LOG_NAME = _LOG_NAMES[0]
_BUFFER_MAXLEN = 800

_buffer: Deque[str] = deque(maxlen=_BUFFER_MAXLEN)
_lock = threading.Lock()
_installed = False  # guards against double-attach


class RingBufferHandler(logging.Handler):
    """A logging.Handler that appends each formatted record to the shared
    in-memory ring buffer.  Never raises; failures are silently swallowed
    so a logging glitch can never break the ingest pipeline."""

    def emit(self, record: logging.LogRecord) -> None:  # noqa: D401
        try:
            ts = datetime.fromtimestamp(record.created, tz=timezone.utc) \
                .strftime("%Y-%m-%d %H:%M:%S UTC")
            level = record.levelname
            try:
                msg = record.getMessage()
            except Exception:  # noqa: BLE001
                msg = record.msg if isinstance(record.msg, str) else repr(record.msg)
            line = f"{ts}  {level:<8}  {record.name}  {msg}"
            with _lock:
                _buffer.append(line)
        except Exception:  # noqa: BLE001
            # Swallow every error — logging must never break the app.
            pass


def install_buffer() -> bool:
    """Attach the RingBufferHandler to all watched ingest source loggers.

    Idempotent: returns True on first install, False if already installed.
    """
    global _installed
    with _lock:
        if _installed:
            return False
        handler = RingBufferHandler(level=logging.DEBUG)
        for log_name in _LOG_NAMES:
            target = logging.getLogger(log_name)
            # Don't change the logger's existing level — just observe.
            target.addHandler(handler)
        _installed = True
        return True


def get_recent(max_lines: int = 200, level_min: str = "INFO") -> List[str]:
    """Return the most recent N lines from the ring buffer, optionally
    filtered by minimum level.  level_min is matched substring-style on
    the level token in the formatted line (e.g. 'WARNING', 'ERROR')."""
    if max_lines <= 0:
        return []
    order = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50}
    threshold = order.get(level_min.upper(), 20)

    with _lock:
        snapshot = list(_buffer)

    def passes(line: str) -> bool:
        for name, value in order.items():
            if f"  {name:<8}  " in line:
                return value >= threshold
        return True  # If we can't parse the level, include it.

    return [line for line in snapshot if passes(line)][-max_lines:]


def clear() -> int:
    """Drop all buffered lines.  Returns the number of lines removed.
    Intended for use by the probe endpoint so probe output is isolated."""
    with _lock:
        n = len(_buffer)
        _buffer.clear()
        return n
