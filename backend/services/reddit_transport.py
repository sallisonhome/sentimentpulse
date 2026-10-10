"""Run-scoped HTTP reuse; successful empties are distinct from failed reads.

No persisted cursor changes: every active title still traverses its full
configured sources. Cached JSON is copied before per-game relevance tagging.
"""
import json
import logging
import threading
import time
from collections import Counter, OrderedDict
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import requests

log = logging.getLogger(__name__)
_local = threading.local()
_lock = threading.Lock()
_next_request = {}


class FetchRows(list):
    def __init__(self, rows=(), *, complete=True, checked_through=None, stop_reason=None,
                 resume=None):
        super().__init__(rows)
        self.complete = complete
        self.checked_through = checked_through if complete else None
        self.stop_reason = stop_reason
        # Scanned-interval progress for a time-budgeted listing (never a
        # completeness claim); only meaningful while incomplete.
        self.resume = None if complete else resume


class UpstreamFailure(RuntimeError):
    pass


class CircuitOpen(UpstreamFailure):
    """Raised without a network call while a provider's breaker is open."""


class _OutageFailure(UpstreamFailure):
    """Timeout, connection error or 5xx: counts toward the breaker."""


class _CooldownActive(UpstreamFailure):
    """Local pacing refusal: says nothing about provider reachability."""


# 2026-10-10: Arctic Shift returned Cloudflare 522 / ReadTimeout on every
# request for hours. Each failed read cost ~35 s (two 15 s attempts plus a
# 5 s cooldown), so one game's Reddit comments took ~87 min and the run had
# finished 8 of 49 games after 4.5 h. After this many consecutive outage-class
# failures (timeout, connection error, HTTP 5xx) for one provider within a
# run, stop calling it. Every skipped read raises UpstreamFailure, so callers
# keep their existing "incomplete, cursor not advanced, retry next run" path
# and their fallbacks (gist, PullPush) still run.
BREAKER_THRESHOLD = 5
# One probe request is allowed per cooldown so a mid-run recovery is used.
BREAKER_COOLDOWN_S = 900


def _new_breaker():
    return {"state": "closed", "consecutive_failures": 0, "trips": 0,
            "short_circuited": 0, "opened_at": None, "opened_at_monotonic": None,
            "last_error": None}


def _breakers():
    breakers = getattr(_local, "breakers", None)
    if breakers is None:
        breakers = {}
        _local.breakers = breakers
    return breakers


def _is_outage_status(status):
    return 500 <= status <= 599 and status != 501


def _breaker_gate(provider):
    """Raise CircuitOpen if the provider is open and no probe is due."""
    breaker = _breakers().get(provider)
    if breaker is None or breaker["state"] == "closed":
        return
    if breaker["state"] == "open" and (
        time.monotonic() - breaker["opened_at_monotonic"] >= BREAKER_COOLDOWN_S
    ):
        breaker["state"] = "half_open"
        log.warning("reddit_transport breaker provider=%s half_open: probing once", provider)
        return
    breaker["short_circuited"] += 1
    getattr(_local, "metrics", Counter())[f"{provider}_short_circuited"] += 1
    raise CircuitOpen(
        f"{provider} circuit open after {breaker['consecutive_failures']} consecutive "
        f"failures (last: {breaker['last_error']}); request skipped")


def _breaker_success(provider):
    breaker = _breakers().get(provider)
    if breaker is None:
        return
    if breaker["state"] != "closed":
        log.warning("reddit_transport breaker provider=%s closed: provider recovered",
                    provider)
    breaker["state"] = "closed"
    breaker["consecutive_failures"] = 0


def _breaker_failure(provider, reason):
    breaker = _breakers().setdefault(provider, _new_breaker())
    breaker["consecutive_failures"] += 1
    breaker["last_error"] = reason
    reopen = breaker["state"] == "half_open"
    if reopen or (breaker["state"] == "closed" and
                  breaker["consecutive_failures"] >= BREAKER_THRESHOLD):
        if not reopen:
            breaker["trips"] += 1
        breaker["state"] = "open"
        breaker["opened_at"] = datetime.now(timezone.utc).isoformat()
        breaker["opened_at_monotonic"] = time.monotonic()
        log.warning(
            "reddit_transport breaker provider=%s open: %d consecutive failures "
            "(last: %s); skipping requests for %ds", provider,
            breaker["consecutive_failures"], reason, BREAKER_COOLDOWN_S)


def breaker_snapshot():
    """JSON-safe per-provider breaker state for this run (tripped ones only)."""
    out = {}
    for provider, breaker in _breakers().items():
        if breaker["trips"]:
            out[provider] = {k: v for k, v in breaker.items()
                             if k != "opened_at_monotonic"}
    return out


def circuit_open(provider):
    """True while requests to provider would be skipped (no probe due)."""
    breaker = _breakers().get(provider)
    return bool(
        breaker and breaker["state"] == "open" and
        time.monotonic() - breaker["opened_at_monotonic"] < BREAKER_COOLDOWN_S)


def begin_run():
    end_run()
    _local.session = requests.Session()
    _local.cache = OrderedDict()
    _local.cache_bytes = 0
    _local.metrics = Counter()
    _local.started_epoch = int(time.time())
    _local.listing_cache = None
    _local.breakers = {}


def end_run():
    listing_cache = getattr(_local, "listing_cache", None)
    if listing_cache is not None:
        listing_cache.close()
        _local.listing_cache = None
    session = getattr(_local, "session", None)
    if session:
        session.close()
        log.info("reddit_transport run metrics=%s", dict(_local.metrics))
        if breaker_snapshot():
            log.warning("reddit_transport run breakers=%s", breaker_snapshot())
    _local.session = None
    _local.cache = None


def run_active():
    return getattr(_local, "session", None) is not None


def retry_seconds(headers, default=5):
    value = headers.get("Retry-After")
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        try:
            return max(0.0, (parsedate_to_datetime(value) -
                            datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            pass
    # Arctic Shift documents these headers, rather than Retry-After.
    # Reset is a duration; Reset-At can be epoch milliseconds.
    try:
        return max(0.0, float(headers["X-RateLimit-Reset"]))
    except (KeyError, TypeError, ValueError):
        try:
            epoch = float(headers["X-RateLimit-Reset-At"])
            if epoch > 100_000_000_000:
                epoch /= 1000
            return max(0.0, epoch - time.time())
        except (KeyError, TypeError, ValueError):
            return float(default)


def _pace(provider, interval):
    with _lock:
        now = time.monotonic()
        wait = max(0.0, _next_request.get(provider, 0.0) - now)
        if wait > 120:
            raise _CooldownActive(f"{provider} cooldown active for {wait:.0f}s")
        _next_request[provider] = now + wait + interval
    if wait:
        time.sleep(wait)
        getattr(_local, "metrics", Counter())["pacing_seconds"] += wait


def fetch_json(url, params, *, headers, timeout, provider, interval):
    """Two bounded attempts during ingestion; failed payloads are never cached.

    Outside an ingestion context retain a single requests.get call for existing
    callers. Inside, reuse TLS connections and coalesce identical successful
    reads for this run. Provider pacing is shared with all contexts.
    """
    session = getattr(_local, "session", None)
    cache = getattr(_local, "cache", None)
    metrics = getattr(_local, "metrics", Counter())
    key = (url, tuple(sorted(params.items())))
    if cache is not None and key in cache:
        metrics["cache_hits"] += 1
        cache.move_to_end(key)
        return json.loads(cache[key])
    attempts = 2 if session is not None else 1
    if session is None:
        return _fetch_attempts(url, params, headers=headers, timeout=timeout,
                               provider=provider, interval=interval,
                               session=None, cache=cache, metrics=metrics,
                               key=key, attempts=attempts)
    _breaker_gate(provider)
    try:
        payload = _fetch_attempts(url, params, headers=headers, timeout=timeout,
                                  provider=provider, interval=interval,
                                  session=session, cache=cache, metrics=metrics,
                                  key=key, attempts=attempts)
    except _OutageFailure as exc:
        _breaker_failure(provider, str(exc))
        raise
    except _CooldownActive:
        raise
    except UpstreamFailure:
        # The provider answered (4xx, 422/429, bad schema): reachable.
        _breaker_success(provider)
        raise
    _breaker_success(provider)
    return payload


def _fetch_attempts(url, params, *, headers, timeout, provider, interval,
                    session, cache, metrics, key, attempts):
    for attempt in range(attempts):
        if session is not None:
            _pace(provider, interval)
        metrics["requests"] += 1
        request_started = time.monotonic()
        try:
            response = (session.get if session is not None else requests.get)(
                url, params=params, headers=headers, timeout=timeout)
            status = response.status_code
            metrics[f"http_{status}"] += 1
            metrics[f"{provider}_http_{status}"] += 1
            if status == 200:
                payload = response.json()
                # Missing/error schemas are failures, not successful empties.
                data = payload.get("data") if isinstance(payload, dict) else payload
                if isinstance(data, list) and not (
                    isinstance(payload, dict) and payload.get("error")
                ):
                    if cache is not None:
                        encoded = json.dumps(payload)
                        size = len(encoded)
                        # Shared host has 2GB RAM. Bound cached serialized
                        # payloads, not thousands of mutable decoded responses.
                        if size <= 8 * 1024 * 1024:
                            while cache and (
                                len(cache) >= 256 or
                                _local.cache_bytes + size > 8 * 1024 * 1024
                            ):
                                _, old = cache.popitem(last=False)
                                _local.cache_bytes -= len(old)
                            cache[key] = encoded
                            _local.cache_bytes += size
                    return payload
                raise UpstreamFailure("upstream error or invalid data schema")
            if status not in (422, 429, 500, 502, 503, 504):
                # Cloudflare 520-524 (origin unreachable) is an outage too.
                if _is_outage_status(status):
                    raise _OutageFailure(f"HTTP {status}")
                raise UpstreamFailure(f"HTTP {status}")
            # 422 is a query timeout, not a provider rate limit. Previously
            # every failed query imposed an invented 5s retry + 10s GLOBAL
            # cooldown, delaying unrelated comment reads too. Still retry the
            # query once (warm databases can recover), at normal courtesy pace.
            # Explicit Retry-After remains authoritative on every status;
            # rate-reset headers apply to 429 only, not every 422/200 response.
            delay_headers = response.headers if status == 429 else {
                "Retry-After": response.headers.get("Retry-After")
            }
            delay = retry_seconds(
                delay_headers, default=0 if status == 422 else 5 * (attempt + 1))
            # Respect long Retry-After without sleeping for an unbounded period:
            # publish cooldown, fail this request visibly, allow fallback.
            if session is not None and delay:
                with _lock:
                    _next_request[provider] = max(
                        _next_request.get(provider, 0), time.monotonic() + delay)
            if delay > 120 or attempt + 1 == attempts:
                failure = (_OutageFailure if _is_outage_status(status)
                           else UpstreamFailure)
                raise failure(f"HTTP {status}; retry after {delay:.0f}s")
        except (requests.RequestException, ValueError) as exc:
            if attempt + 1 == attempts:
                outage = isinstance(exc, (requests.Timeout, requests.ConnectionError,
                                          requests.exceptions.ChunkedEncodingError))
                raise (_OutageFailure if outage else UpstreamFailure)(
                    type(exc).__name__) from exc
            if session is not None:
                with _lock:
                    _next_request[provider] = max(
                        _next_request.get(provider, 0), time.monotonic() + 5)
        finally:
            metrics["http_seconds"] += time.monotonic() - request_started
    raise UpstreamFailure("upstream request exhausted")
