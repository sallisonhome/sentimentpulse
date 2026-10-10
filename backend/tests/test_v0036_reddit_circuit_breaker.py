"""2026-10-10: Reddit provider circuit breaker.

Arctic Shift returned Cloudflare 522 / ReadTimeout on every request for
hours. Each failed read cost ~35 s (two 15 s attempts + 5 s cooldown), so
Tempest Rising's and Hellraiser's Reddit comments took ~86-87 min each and
the run finished 8 of 49 games in 4.5 h. These tests pin the breaker:
consecutive outage-class failures open it, open means no network call,
reachable-but-unhappy responses never trip it, a probe after the cooldown
lets a recovery be used, and the ingest reports it as partial Reddit.
"""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

from services import reddit_transport as rt


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def transport(monkeypatch):
    rt.end_run()
    rt._next_request.clear()
    clock = Clock()
    monkeypatch.setattr(rt.time, "sleep", lambda _: None)
    monkeypatch.setattr(rt.time, "monotonic", clock)
    monkeypatch.setattr(rt, "_pace", lambda provider, interval: None)
    client = Mock()
    monkeypatch.setattr(rt.requests, "Session", lambda: client)
    rt.begin_run()
    client.clock = clock
    yield client
    rt.end_run()
    rt._next_request.clear()


def response(status=200, data=None):
    return SimpleNamespace(status_code=status, headers={},
                           json=lambda: {"data": data if data is not None else []})


def fetch(n=0, provider="arctic_shift"):
    return rt.fetch_json("https://example.test/api", {"q": n}, headers={},
                         timeout=15, provider=provider, interval=1.0)


def fail_times(k, start=0, provider="arctic_shift"):
    for i in range(k):
        with pytest.raises(rt.UpstreamFailure):
            fetch(start + i, provider)


def test_consecutive_timeouts_open_breaker_and_skip_network(transport):
    transport.get.side_effect = requests.ReadTimeout("read timed out")
    fail_times(rt.BREAKER_THRESHOLD)
    calls = transport.get.call_count
    assert calls == rt.BREAKER_THRESHOLD * 2  # two bounded attempts each
    assert rt.circuit_open("arctic_shift")
    for i in range(50):
        with pytest.raises(rt.CircuitOpen):
            fetch(100 + i)
    assert transport.get.call_count == calls  # no network while open
    snap = rt.breaker_snapshot()["arctic_shift"]
    assert snap["state"] == "open" and snap["trips"] == 1
    assert snap["short_circuited"] == 50
    assert snap["last_error"] == "ReadTimeout"
    assert "opened_at_monotonic" not in snap


def test_circuit_open_is_an_upstream_failure_for_existing_callers(transport):
    # Callers' "incomplete, cursor not advanced" path catches UpstreamFailure.
    assert issubclass(rt.CircuitOpen, rt.UpstreamFailure)


def test_cloudflare_522_counts_as_outage(transport):
    transport.get.return_value = response(522)
    fail_times(rt.BREAKER_THRESHOLD)
    assert rt.circuit_open("arctic_shift")
    assert rt.breaker_snapshot()["arctic_shift"]["last_error"] == "HTTP 522"


def test_5xx_and_connection_errors_count(transport):
    transport.get.side_effect = [response(503), response(503),
                                 requests.ConnectionError(), requests.ConnectionError(),
                                 response(502), response(502),
                                 requests.ConnectTimeout(), requests.ConnectTimeout(),
                                 response(520)]
    fail_times(rt.BREAKER_THRESHOLD)
    assert rt.circuit_open("arctic_shift")


@pytest.mark.parametrize("status", [400, 403, 404, 422, 429])
def test_reachable_errors_never_trip(transport, status):
    transport.get.return_value = response(status)
    fail_times(rt.BREAKER_THRESHOLD * 3)
    assert not rt.circuit_open("arctic_shift")
    assert rt.breaker_snapshot() == {}


def test_reachable_error_resets_the_streak(transport):
    transport.get.side_effect = requests.ReadTimeout()
    fail_times(rt.BREAKER_THRESHOLD - 1)
    transport.get.side_effect = None
    transport.get.return_value = response(404)
    fail_times(1, start=50)
    transport.get.side_effect = requests.ReadTimeout()
    fail_times(rt.BREAKER_THRESHOLD - 1, start=100)
    assert not rt.circuit_open("arctic_shift")


def test_success_resets_the_streak(transport):
    transport.get.side_effect = requests.ReadTimeout()
    fail_times(rt.BREAKER_THRESHOLD - 1)
    transport.get.side_effect = None
    transport.get.return_value = response(data=[{"id": "a"}])
    assert fetch(50) == {"data": [{"id": "a"}]}
    transport.get.side_effect = requests.ReadTimeout()
    fail_times(rt.BREAKER_THRESHOLD - 1, start=100)
    assert not rt.circuit_open("arctic_shift")


def test_probe_after_cooldown_closes_on_recovery(transport):
    transport.get.side_effect = requests.ReadTimeout()
    fail_times(rt.BREAKER_THRESHOLD)
    transport.clock.now += rt.BREAKER_COOLDOWN_S
    assert not rt.circuit_open("arctic_shift")  # a probe is due
    transport.get.side_effect = None
    transport.get.return_value = response(data=[{"id": "b"}])
    assert fetch(500) == {"data": [{"id": "b"}]}
    assert fetch(501) == {"data": [{"id": "b"}]}
    snap = rt.breaker_snapshot()["arctic_shift"]
    assert snap["state"] == "closed" and snap["trips"] == 1


def test_failed_probe_reopens_after_one_request(transport):
    transport.get.side_effect = requests.ReadTimeout()
    fail_times(rt.BREAKER_THRESHOLD)
    transport.clock.now += rt.BREAKER_COOLDOWN_S
    before = transport.get.call_count
    with pytest.raises(rt.UpstreamFailure) as exc:
        fetch(600)
    assert not isinstance(exc.value, rt.CircuitOpen)  # the probe really ran
    assert transport.get.call_count == before + 2
    with pytest.raises(rt.CircuitOpen):
        fetch(601)
    assert transport.get.call_count == before + 2
    assert rt.breaker_snapshot()["arctic_shift"]["trips"] == 1  # same outage


def test_breakers_are_per_provider(transport):
    transport.get.side_effect = requests.ReadTimeout()
    fail_times(rt.BREAKER_THRESHOLD, provider="arctic_shift")
    transport.get.side_effect = None
    transport.get.return_value = response(data=[])
    assert fetch(1, provider="pullpush") == {"data": []}
    assert rt.circuit_open("arctic_shift") and not rt.circuit_open("pullpush")


def test_cache_hits_still_served_while_open(transport):
    transport.get.return_value = response(data=[{"id": "c"}])
    assert fetch(7) == {"data": [{"id": "c"}]}
    transport.get.return_value = None
    transport.get.side_effect = requests.ReadTimeout()
    fail_times(rt.BREAKER_THRESHOLD, start=10)
    assert fetch(7) == {"data": [{"id": "c"}]}


def test_local_cooldown_does_not_count_as_reachable(transport, monkeypatch):
    transport.get.side_effect = requests.ReadTimeout()
    fail_times(rt.BREAKER_THRESHOLD - 1)

    def refuse(provider, interval):
        raise rt._CooldownActive("arctic_shift cooldown active for 300s")

    monkeypatch.setattr(rt, "_pace", refuse)
    with pytest.raises(rt.UpstreamFailure):
        fetch(99)
    monkeypatch.setattr(rt, "_pace", lambda provider, interval: None)
    fail_times(1, start=200)
    assert rt.circuit_open("arctic_shift")


def test_begin_run_resets_breakers(transport):
    transport.get.side_effect = requests.ReadTimeout()
    fail_times(rt.BREAKER_THRESHOLD)
    rt.begin_run()
    assert not rt.circuit_open("arctic_shift")
    assert rt.breaker_snapshot() == {}


def test_outside_a_run_there_is_no_breaker(monkeypatch):
    rt.end_run()
    calls = []

    def get(*a, **k):
        calls.append(1)
        raise requests.ReadTimeout()

    monkeypatch.setattr(rt.requests, "get", get)
    for i in range(rt.BREAKER_THRESHOLD * 2):
        with pytest.raises(rt.UpstreamFailure):
            fetch(i)
    assert len(calls) == rt.BREAKER_THRESHOLD * 2  # every call still tried


def test_oct10_outage_cost_is_bounded(transport):
    """A whole-run outage costs threshold x attempts requests, not thousands."""
    transport.get.side_effect = requests.ReadTimeout()
    for i in range(2000):  # ~ the listing + comment reads of a full run
        with pytest.raises(rt.UpstreamFailure):
            fetch(i)
    assert transport.get.call_count == rt.BREAKER_THRESHOLD * 2


# ── ingestor wiring ──────────────────────────────────────────────────────────

def test_breaker_errors_mark_reddit_partial():
    from services.ingestor import _reddit_breaker_errors, _reddit_completeness_health
    lines = _reddit_breaker_errors({"arctic_shift": {
        "state": "open", "trips": 1, "short_circuited": 812,
        "opened_at": "2026-10-10T09:51:00+00:00", "last_error": "HTTP 522",
        "consecutive_failures": 5}})
    assert len(lines) == 1 and lines[0].startswith("[Step 4] ")
    assert "arctic_shift" in lines[0] and "812 request(s) skipped" in lines[0]
    assert "Cursors not advanced" in lines[0]
    assert _reddit_completeness_health("ok", lines) == "partial"
    assert _reddit_breaker_errors({}) == []


def test_step4a_skips_remaining_parents_with_one_line(transport, monkeypatch):
    from services import ingestor
    from services import arctic_shift_service

    transport.get.side_effect = requests.ReadTimeout()
    fail_times(rt.BREAKER_THRESHOLD)
    assert rt.circuit_open("arctic_shift")

    parents = [SimpleNamespace(external_id=f"p{i}", url=f"https://www.reddit.com/r/x/{i}")
               for i in range(7)]

    class Q:
        def __init__(self, *a, **k): pass
        def filter(self, *a, **k): return self
        def order_by(self, *a, **k): return self
        def limit(self, *a, **k): return self
        def all(self): return parents

    db = SimpleNamespace(query=lambda *a, **k: Q())
    called = []
    monkeypatch.setattr(arctic_shift_service, "fetch_arctic_shift_comments",
                        lambda **k: called.append(k) or [])
    game = SimpleNamespace(id=2, name="Tempest Rising", subreddits=["TempestRising"])
    errors, log_lines = [], []
    saved, fetched = ingestor._step4a_reddit_comments(db, game, log_lines, errors)
    assert (saved, fetched) == (0, 0)
    assert called == []
    step4a = [e for e in errors if e.startswith("[Step 4a]")]
    assert step4a == ["[Step 4a] 'Tempest Rising': Arctic Shift circuit open; "
                      "skipped 7 of 7 parent(s); retry on next run"]


def test_status_carries_and_hydrates_reddit_circuit():
    from services import ingestor
    assert "reddit_circuit" in ingestor._status
    import inspect
    src = inspect.getsource(ingestor.get_status)
    assert '"reddit_circuit"' in src
    run_src = inspect.getsource(ingestor.run_ingestion)
    assert '"reddit_circuit": _status.get("reddit_circuit")' in run_src
    assert '_status["reddit_circuit"] = _reddit_breaker_snapshot()' in run_src
