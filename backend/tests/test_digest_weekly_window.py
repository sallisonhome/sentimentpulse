"""Guard: v0032 (2026-09-21) — the weekly digest MUST cover the calendar
week that just ended (previous Monday through previous Sunday), not
\"the last 7 days ending today\".

Before v0032, `build_weekly_block` and `build_weekly_digest` used
`today` (Monday 07:00 ET when the scheduler fires) as the end-of-window,
which meant the Monday digest covered Tuesday–Monday and included the
current day with almost no data. Every real Mon–Sun week was split
across two consecutive digests.

Fix: anchor on `_weekly_window_end(today)` = the most-recent Sunday
strictly before today, and pass that as `end_date` to
generate_window_summary().

These tests exercise the helper directly (pure date math, no DB or
service dependencies).
"""
from datetime import date, timedelta

from services.digest_service import _weekly_window_end, _weekly_period_label


class TestWeeklyWindowEnd:
    def test_monday_returns_previous_sunday(self):
        """Digest fires Monday 07:00 ET → window ends previous Sunday."""
        today = date(2026, 9, 21)  # Monday
        assert _weekly_window_end(today) == date(2026, 9, 20)  # Sunday

    def test_returned_date_is_always_a_sunday(self):
        """No matter what weekday `today` is, the returned date must be
        a Sunday. Sun's weekday() == 6."""
        for i in range(0, 14):
            today = date(2026, 9, 14) + timedelta(days=i)
            end = _weekly_window_end(today)
            assert end.weekday() == 6, (
                f"today={today} ({today.strftime('%a')}) → end={end} "
                f"({end.strftime('%a')}) is not a Sunday"
            )

    def test_sunday_rolls_back_to_prior_sunday(self):
        """A digest fired on Sunday itself must not include the current
        day (weekly-review email → never include today)."""
        today = date(2026, 9, 20)  # Sunday
        assert _weekly_window_end(today) == date(2026, 9, 13)  # prior Sunday

    def test_tuesday_still_returns_last_sunday(self):
        """A manual run on Tuesday should still cover the just-completed
        Mon–Sun week — not roll forward to the current one."""
        today = date(2026, 9, 22)  # Tuesday
        assert _weekly_window_end(today) == date(2026, 9, 20)  # prior Sunday

    def test_window_is_always_7_days_monday_to_sunday(self):
        """Full window contract: end - 6 must be a Monday, end must be a
        Sunday, and the pair forms a full calendar week."""
        for i in range(0, 14):
            today = date(2026, 9, 14) + timedelta(days=i)
            end = _weekly_window_end(today)
            start = end - timedelta(days=6)
            assert start.weekday() == 0, (
                f"today={today} → window_start={start} ({start.strftime('%a')}) "
                f"is not a Monday"
            )
            assert end.weekday() == 6
            assert (end - start).days == 6, (
                f"window {start}..{end} is not exactly 7 days"
            )


class TestWeeklyPeriodLabel:
    def test_label_reflects_prev_mon_sun_when_fed_correct_end(self):
        """When build_weekly_digest passes _weekly_window_end(today) into
        _weekly_period_label, the label reads Mon–Sun of the just-ended
        week."""
        today = date(2026, 9, 21)  # Monday
        end = _weekly_window_end(today)
        label = _weekly_period_label(end)
        # Start should be Sep 14 (Mon), end Sep 20 (Sun) 2026.
        assert "Sep 14" in label
        assert "Sep 20" in label
        assert "2026" in label
