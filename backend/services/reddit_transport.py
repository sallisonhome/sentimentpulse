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
    def __init__(self, rows=(), *, complete=True):
        super().__init__(rows)
        self.complete = complete


class UpstreamFailure(RuntimeError):
    pass


def begin_run():
    end_run()
    _local.session = requests.Session()
    _local.cache = OrderedDict()
    _local.cache_bytes = 0
    _local.metrics = Counter()


def end_run():
    session = getattr(_local, "session", None)
    if session:
        session.close()
        log.info("reddit_transport run metrics=%s", dict(_local.metrics))
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
            return float(default)


def _pace(provider, interval):
    with _lock:
        now = time.monotonic()
        wait = max(0.0, _next_request.get(provider, 0.0) - now)
        if wait > 120:
            raise UpstreamFailure(f"{provider} cooldown active for {wait:.0f}s")
        _next_request[provider] = now + wait + interval
    if wait:
        time.sleep(wait)


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
    for attempt in range(attempts):
        if session is not None:
            _pace(provider, interval)
        metrics["requests"] += 1
        try:
            response = (session.get if session is not None else requests.get)(
                url, params=params, headers=headers, timeout=timeout)
            status = response.status_code
            metrics[f"http_{status}"] += 1
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
                raise UpstreamFailure(f"HTTP {status}")
            delay = retry_seconds(response.headers, default=5 * (attempt + 1))
            # Respect long Retry-After without sleeping for an unbounded period:
            # publish cooldown, fail this request visibly, allow fallback.
            if session is not None:
                with _lock:
                    _next_request[provider] = max(
                        _next_request.get(provider, 0), time.monotonic() + delay)
            if delay > 120 or attempt + 1 == attempts:
                raise UpstreamFailure(f"HTTP {status}; retry after {delay:.0f}s")
        except (requests.RequestException, ValueError) as exc:
            if attempt + 1 == attempts:
                raise UpstreamFailure(type(exc).__name__) from exc
            if session is not None:
                with _lock:
                    _next_request[provider] = max(
                        _next_request.get(provider, 0), time.monotonic() + 5)
    raise UpstreamFailure("upstream request exhausted")
