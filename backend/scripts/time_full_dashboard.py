"""Time the full _compute_dashboard call end-to-end for Hellraiser lifetime.

Calls the real function the API calls, records wall time, and prints
every SQL statement + duration via SQLAlchemy event hooks.

Read-only. Safe on prod.
"""
import sys
import time
sys.path.insert(0, "/opt/sentimentpulse/backend")

from sqlalchemy import event, create_engine
from sqlalchemy.orm import Session

engine = create_engine("sqlite:///sentimentpulse.db")


timings: list[tuple[float, str]] = []


@event.listens_for(engine, "before_cursor_execute")
def _before(conn, cursor, statement, parameters, context, executemany):
    context._start = time.monotonic()


@event.listens_for(engine, "after_cursor_execute")
def _after(conn, cursor, statement, parameters, context, executemany):
    elapsed = time.monotonic() - context._start
    if elapsed >= 0.02:  # only log statements ≥ 20ms
        # Compact statement — first 200 chars
        first_line = " ".join(statement.split())[:200]
        timings.append((elapsed, first_line))


# Now run _compute_dashboard for Hellraiser lifetime.
# Patch the module's engine to ours so events fire.
import database
database.engine = engine
database.SessionLocal.configure(bind=engine)

from routers.dashboard import _compute_dashboard
from schemas import PeriodEnum

for period_str in ("weekly", "monthly", "quarterly", "lifetime"):
    period = PeriodEnum[period_str]
    print(f"\n{'=' * 60}")
    print(f"  Full _compute_dashboard for game_id=21 period={period_str}")
    print(f"{'=' * 60}")
    timings.clear()

    with Session(engine) as db:
        start = time.monotonic()
        try:
            resp = _compute_dashboard(21, period, db)
        except Exception as e:
            print(f"  ERROR: {e}")
            continue
        elapsed = time.monotonic() - start

    print(f"  END-TO-END: {elapsed:.2f}s")
    print(f"  Statements ≥20ms: {len(timings)}")
    # Sort slowest first
    timings.sort(reverse=True)
    for i, (t, sql) in enumerate(timings[:20]):
        print(f"    [{i+1}] {t:.2f}s  {sql}")

print("\ndone.")
