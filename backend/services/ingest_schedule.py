"""Daily slot admission shared by scheduled fires and startup recovery."""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")


def admission_reason(status, *, hour, minute, now=None, startup=False):
    now = (now or datetime.now(timezone.utc)).astimezone(ET)
    due = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if now < due:
        return "before_daily_slot"
    if status.get("is_running"):
        return "already_running"
    last = status.get("last_run_at")
    if not last:
        return "no_prior_history" if startup else None
    # A completed run spanning the due slot also satisfies it. Partial runs
    # remain partial, but aren't repeated wholesale on every deploy.
    if status.get("last_run_status") in ("success", "partial", "partial_failure"):
        value = status.get("last_run_finished_at") or last
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if dt >= due:
                return "daily_slot_already_completed"
        except (TypeError, ValueError):
            return "invalid_run_history"
    return None
