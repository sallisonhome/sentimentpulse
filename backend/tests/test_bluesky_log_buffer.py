"""Unit tests for services.bluesky_log_buffer."""
import logging

import pytest

from services import bluesky_log_buffer as buf


@pytest.fixture(autouse=True)
def _clean_buffer():
    """Each test starts with an empty buffer."""
    buf.clear()
    yield
    buf.clear()


def test_install_buffer_is_idempotent():
    # Reset state — calls before this fixture may have installed it.
    # We can't easily un-install in tests, so we just verify the second
    # install is a no-op.
    first = buf.install_buffer()
    second = buf.install_buffer()
    assert first in (True, False)  # depends on prior state
    assert second is False
    # Confirm exactly one handler is attached to each watched logger
    for log_name in buf._LOG_NAMES:
        log = logging.getLogger(log_name)
        handler_count = sum(
            1 for h in log.handlers if isinstance(h, buf.RingBufferHandler)
        )
        assert handler_count == 1, f"{log_name}: expected 1 handler, got {handler_count}"


def test_buffer_captures_all_watched_sources():
    """Records emitted by any source service must land in the buffer."""
    buf.install_buffer()
    for log_name in buf._LOG_NAMES:
        logging.getLogger(log_name).warning("smoke from %s", log_name)
    lines = buf.get_recent()
    for log_name in buf._LOG_NAMES:
        assert any(log_name in l for l in lines), (
            f"Buffer missing record from {log_name}.  Lines: {lines}"
        )


def test_emit_captures_warning():
    buf.install_buffer()
    logging.getLogger("services.bluesky_service").warning("test warning")
    lines = buf.get_recent()
    assert any("test warning" in line for line in lines)
    assert any("WARNING" in line for line in lines)


def test_get_recent_filters_by_level():
    buf.install_buffer()
    log = logging.getLogger("services.bluesky_service")
    log.setLevel(logging.DEBUG)
    log.warning("warn line")
    log.error("err line")

    only_errors = buf.get_recent(level_min="ERROR")
    assert any("err line" in line for line in only_errors)
    assert not any("warn line" in line for line in only_errors)

    warnings_plus = buf.get_recent(level_min="WARNING")
    assert any("err line" in line for line in warnings_plus)
    assert any("warn line" in line for line in warnings_plus)


def test_clear_drops_all_lines():
    buf.install_buffer()
    logging.getLogger("services.bluesky_service").error("will be dropped")
    assert buf.get_recent()  # non-empty
    dropped = buf.clear()
    assert dropped >= 1
    assert buf.get_recent() == []


def test_ring_buffer_capped_at_maxlen():
    buf.install_buffer()
    log = logging.getLogger("services.bluesky_service")
    # Emit more than _BUFFER_MAXLEN records
    target = buf._BUFFER_MAXLEN + 50
    for i in range(target):
        log.error("record %d", i)
    lines = buf.get_recent(max_lines=buf._BUFFER_MAXLEN)
    assert len(lines) == buf._BUFFER_MAXLEN
    # Most recent record (record N-1) must be present; very first (record 0)
    # must have been evicted.
    assert any(f"record {target - 1}" in line for line in lines)
    assert not any(f"record 0 " in line.replace("\n", " ") for line in lines)


def test_emit_swallows_handler_internal_errors(monkeypatch):
    """RingBufferHandler.emit must never re-raise — even if formatting fails
    inside the handler itself."""
    buf.install_buffer()
    # Force the deque append to throw
    import services.bluesky_log_buffer as mod

    class _ExplodingDeque:
        def append(self, x):
            raise RuntimeError("boom")
        def __len__(self):
            return 0
        def __iter__(self):
            return iter([])
        def clear(self):
            pass

    monkeypatch.setattr(mod, "_buffer", _ExplodingDeque())
    # Must not raise
    logging.getLogger("services.bluesky_service").warning("should not crash")
