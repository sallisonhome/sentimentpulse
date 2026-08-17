"""
Regression tests for the Steam scraper's age-gate bypass (v2, 2026-08-17).

WHY THESE EXIST
---------------
Steam gates the DISCUSSION HTML of adult / mature-rated titles behind an
age check. When our scraper hits that page without the age-gate cookies,
Steam returns a 200-OK stub page containing zero thread rows — no error,
no redirect, no signal that anything was blocked. The scraper interpreted
this as "forum is empty" and stored 0 posts.

This exact failure hid all 130+ threads of SILENT HILL: Townfall's very
active pre-launch forum. Verified 2026-08-17: our scraper with the old
`SentimentPulse/1.0` UA and no cookies returned 0 posts; the same request
with the age-gate bypass cookies returned 130+.

WHAT THESE TESTS LOCK IN
------------------------
1. Every `requests.get` call from services.steam_service._get MUST send
   the standard Steam age-gate cookies. Removing them would silently
   regress adult-rated titles.
2. The User-Agent MUST look like a real browser. Steam's edge has been
   observed to gate on UA in addition to cookies for some mature titles.
"""
from __future__ import annotations

from unittest.mock import patch, MagicMock

from services import steam_service


def _fake_response(status_code=200, text="<html></html>") -> MagicMock:
    r = MagicMock()
    r.status_code = status_code
    r.text = text
    r.raise_for_status = MagicMock()
    return r


class TestAgeGateBypass:
    """v2 (2026-08-17) — regression guard for the Townfall forum bug."""

    def test_get_sends_age_gate_cookies(self):
        """The _get helper MUST forward the age-gate cookies on every request.

        Without these, Steam returns a 200-OK stub with zero threads for any
        mature-rated title (horror, adult-themed, some M-rated shooters), and
        the scraper silently records 0 posts.
        """
        with patch("services.steam_service.requests.get") as mock_get:
            mock_get.return_value = _fake_response()
            steam_service._get("https://steamcommunity.com/app/1636440/discussions/")

            assert mock_get.called
            _, kwargs = mock_get.call_args
            cookies = kwargs.get("cookies") or {}

            # These four cookie names are the Steam age-gate bypass contract.
            # If Steam ever changes their names, this test will need to be
            # updated in lockstep with services.steam_service._STEAM_AGE_GATE_COOKIES.
            for name in ("birthtime", "mature_content", "wants_mature_content", "lastagecheckage"):
                assert name in cookies, (
                    f"Missing required Steam age-gate cookie {name!r}. "
                    f"Without it, mature-rated forums (Townfall, Hellraiser, "
                    f"Halloween, any horror title) silently return 0 threads."
                )

            # birthtime must be old enough to satisfy the >= 21 gate
            # (Steam checks against the current date). Value 568022401 is
            # 1988-01-01 UTC.
            assert int(cookies["birthtime"]) < 700_000_000, (
                "birthtime cookie must be an old-enough Unix timestamp "
                "for the birth date to be >= 21 years ago."
            )

    def test_get_sends_browser_user_agent(self):
        """The _get helper MUST NOT send an obviously-bot User-Agent.

        Steam's edge has been observed to gate on User-Agent in addition to
        cookies for some mature titles. Our old UA of 'SentimentPulse/1.0'
        was flagged; a standard browser UA works.
        """
        with patch("services.steam_service.requests.get") as mock_get:
            mock_get.return_value = _fake_response()
            steam_service._get("https://steamcommunity.com/app/1636440/discussions/")

            _, kwargs = mock_get.call_args
            ua = (kwargs.get("headers") or {}).get("User-Agent", "")
            assert "Mozilla" in ua, (
                f"User-Agent {ua!r} does not look like a real browser. "
                f"Steam gates some mature forums on UA."
            )
            # Explicit anti-regression: the old bot UA must NOT come back.
            assert "SentimentPulse" not in ua, (
                "The old 'SentimentPulse/1.0' UA got zero threads back from "
                "Steam for mature-rated titles. Do not restore it."
            )
