import logging
import time
from functools import wraps

log = logging.getLogger(__name__)


def timed_step(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        started = time.monotonic()
        game = kwargs.get("game") or (args[1] if len(args) > 1 else None)
        gid = getattr(game, "id", None)
        log.info("ingest_phase start step=%s game_id=%s", fn.__name__, gid)
        outcome = "error"
        try:
            result = fn(*args, **kwargs)
            outcome = "returned"
            return result
        finally:
            # returned != success: upstream partial failures remain in errors.
            log.info("ingest_phase end step=%s game_id=%s elapsed_s=%.3f outcome=%s",
                     fn.__name__, gid, time.monotonic() - started, outcome)
    return wrapper
