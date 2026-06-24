"""Tests for the executive digest service (weekly + monthly)."""
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from models import (
    Base, Game, MonthlySummary, Publisher, WindowSummary,
)
from services import digest_service as ds


# ── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture
def db():
    eng = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(eng)
    Session = sessionmaker(bind=eng)
    s = Session()
    pub = Publisher(name="TestPub")
    s.add(pub)
    s.commit()
    yield s
    s.close()


def _seed_game(db, game_id: int, name: str, app_id: int):
    g = Game(
        id=game_id, publisher_id=1, steam_app_id=app_id,
        name=name, is_active=True, subreddits=[],
    )
    db.add(g)
    db.commit()
    return g


def _seed_window_summary(
    db, game_id: int, *, ingest_date: date,
    positive=10, negative=2, neutral=8, total=20,
    exec_summary="Strong momentum.",
    rec_actions="1. Ship **bug fix**.\n2. Audit perf.",
    bold_ideas=("Cross-promote with partners.",),
):
    ws = WindowSummary(
        game_id=game_id, window_days=7, ingest_date=ingest_date,
        positive_count=positive, negative_count=negative, neutral_count=neutral,
        total_posts=total,
        executive_summary=exec_summary,
        recommended_actions=rec_actions,
        bold_ideas=list(bold_ideas),
    )
    db.add(ws)
    db.commit()
    return ws


def _seed_monthly_summary(db, game_id: int, year: int, month: int, **kwargs):
    defaults = dict(
        positive_count=50, negative_count=5, neutral_count=40, total_posts=95,
        executive_summary="Healthy month overall.",
        recommended_actions="1. Continue **roadmap**.",
        bold_ideas=["Expand partner co-marketing."],
    )
    defaults.update(kwargs)
    ms = MonthlySummary(
        game_id=game_id, period_year=year, period_month=month, **defaults,
    )
    db.add(ms)
    db.commit()
    return ms


# ── Ratio formatting ─────────────────────────────────────────────────────────

class TestRatioFormat:
    def test_positive_dominates(self):
        assert ds._format_ratio(20, 4) == "5.0:1"

    def test_negative_dominates(self):
        assert ds._format_ratio(4, 20) == "1:5.0"

    def test_zero_negative_shows_count_zero(self):
        assert ds._format_ratio(15, 0) == "15:0"

    def test_zero_positive_shows_zero_count(self):
        assert ds._format_ratio(0, 7) == "0:7"

    def test_no_signal(self):
        assert ds._format_ratio(0, 0) == "no signal"

    def test_equal_counts(self):
        assert ds._format_ratio(10, 10) == "1.0:1"


# ── Period labels ────────────────────────────────────────────────────────────

class TestPeriodLabels:
    def test_weekly_same_year(self):
        assert ds._weekly_period_label(date(2026, 6, 24)) == "Jun 18 – Jun 24, 2026"

    def test_weekly_crosses_year(self):
        # Dec 31 - 6 days = Dec 25; still same year
        assert ds._weekly_period_label(date(2026, 12, 31)) == "Dec 25 – Dec 31, 2026"

    def test_weekly_actually_crosses_year(self):
        # Jan 3 - 6 days = Dec 28 prior year
        assert ds._weekly_period_label(date(2027, 1, 3)) == "Dec 28, 2026 – Jan 03, 2027"

    def test_monthly_label(self):
        assert ds._monthly_period_label(2026, 5) == "May 2026"

    def test_prior_month_in_middle(self):
        assert ds._prior_month(date(2026, 7, 15)) == (2026, 6)

    def test_prior_month_january_wraps(self):
        assert ds._prior_month(date(2026, 1, 5)) == (2025, 12)


# ── Building a weekly block ──────────────────────────────────────────────────

class TestBuildWeeklyBlock:
    def test_returns_no_signal_when_no_data(self, db):
        _seed_game(db, 1, "Test Game", 100)
        # Force generate_window_summary to return None
        from unittest.mock import patch
        with patch(
            "services.period_summary_service.generate_window_summary",
            return_value=None,
        ):
            block = ds.build_weekly_block(db, 1, "Test Game", today=date(2026, 6, 24))
        assert block.has_data is False
        assert block.total_posts == 0
        assert block.pos_neg_ratio == "no signal"

    def test_uses_cached_window_summary_when_present(self, db):
        _seed_game(db, 1, "Test Game", 100)
        _seed_window_summary(
            db, 1, ingest_date=date(2026, 6, 24),
            positive=30, negative=5, neutral=15, total=50,
        )
        # If cache exists, generate_window_summary must NOT be called
        from unittest.mock import patch
        with patch(
            "services.period_summary_service.generate_window_summary",
        ) as mock_gen:
            block = ds.build_weekly_block(db, 1, "Test Game", today=date(2026, 6, 24))
            assert mock_gen.call_count == 0
        assert block.has_data is True
        assert block.total_posts == 50
        assert block.positive == 30
        assert block.negative == 5
        assert block.pos_neg_ratio == "6.0:1"

    def test_generates_when_no_cache(self, db):
        _seed_game(db, 1, "Test Game", 100)
        from unittest.mock import MagicMock, patch
        fake = MagicMock(spec=WindowSummary)
        fake.total_posts = 20
        fake.positive_count = 15
        fake.negative_count = 3
        fake.neutral_count = 2
        fake.executive_summary = "Generated."
        fake.recommended_actions = "1. Do thing."
        fake.bold_ideas = []
        with patch(
            "services.period_summary_service.generate_window_summary",
            return_value=fake,
        ) as mock_gen:
            block = ds.build_weekly_block(db, 1, "Test Game", today=date(2026, 6, 24))
            mock_gen.assert_called_once()
        assert block.has_data is True
        assert block.pos_neg_ratio == "5.0:1"

    def test_total_zero_treated_as_no_data(self, db):
        _seed_game(db, 1, "Test Game", 100)
        _seed_window_summary(
            db, 1, ingest_date=date(2026, 6, 24),
            positive=0, negative=0, neutral=0, total=0,
        )
        block = ds.build_weekly_block(db, 1, "Test Game", today=date(2026, 6, 24))
        assert block.has_data is False


# ── Building a monthly block ─────────────────────────────────────────────────

class TestBuildMonthlyBlock:
    def test_returns_no_signal_when_no_row(self, db):
        _seed_game(db, 1, "Test Game", 100)
        block = ds.build_monthly_block(db, 1, "Test Game", 2026, 5)
        assert block.has_data is False
        assert block.pos_neg_ratio == "no signal"
        assert block.period_label == "May 2026"

    def test_returns_block_from_row(self, db):
        _seed_game(db, 1, "Test Game", 100)
        _seed_monthly_summary(
            db, 1, 2026, 5,
            positive_count=60, negative_count=6, neutral_count=34, total_posts=100,
        )
        block = ds.build_monthly_block(db, 1, "Test Game", 2026, 5)
        assert block.has_data is True
        assert block.total_posts == 100
        assert block.pos_neg_ratio == "10.0:1"


# ── Markdown converter ──────────────────────────────────────────────────

class TestMarkdownConverter:
    def test_numbered_list_with_blank_lines_between_items_is_one_list(self):
        """REGRESSION (2026-06-24): the LLM emits numbered recommendations
        separated by blank lines:

            1. Item one

            2. Item two

            3. Item three

        Earlier rendering wrapped each item in its own <ol>, causing every
        item to show '1.' in the email.  Blank lines between numbered items
        must be treated as in-list spacing, NOT a list terminator.
        """
        text = "1. First action.\n\n2. Second action.\n\n3. Third action."
        html = ds._markdown_to_email_html(text)
        # Exactly one <ol> ... </ol> block
        assert html.count("<ol") == 1
        assert html.count("</ol>") == 1
        # All three items inside the same list
        assert html.count("<li") == 3
        # First text appears once, in the only list
        assert "First action." in html
        assert "Second action." in html
        assert "Third action." in html

    def test_numbered_list_terminates_when_non_numbered_text_follows(self):
        text = "1. First.\n\n2. Second.\n\nClosing paragraph here."
        html = ds._markdown_to_email_html(text)
        assert html.count("<ol") == 1
        # Then a paragraph after the list
        assert "<p" in html
        assert "Closing paragraph here." in html

    def test_bold_is_rendered_as_strong(self):
        html = ds._markdown_to_email_html("Ship **the bug fix** today.")
        assert "<strong>the bug fix</strong>" in html

    def test_xss_is_escaped(self):
        html = ds._markdown_to_email_html("Use <script>alert(1)</script>")
        assert "<script>" not in html
        assert "&lt;script&gt;" in html


# ── HTML rendering smoke tests ───────────────────────────────────────────────

class TestRenderDigest:
    def test_metrics_strip_includes_all_counts_and_ratio(self, db):
        _seed_game(db, 1, "Test Game", 100)
        _seed_window_summary(db, 1, ingest_date=date(2026, 6, 24),
                             positive=22, negative=3, neutral=11, total=36)
        block = ds.build_weekly_block(db, 1, "Test Game", today=date(2026, 6, 24))
        strip = ds._render_metrics_strip(block)
        # Counts present
        assert "36" in strip
        assert "22" in strip
        assert "11" in strip
        # Ratio present
        assert "7.3:1" in strip
        # "pos:neg" label
        assert "pos:neg" in strip

    def test_full_html_renders_with_8_priority_titles(self, db):
        # Seed every PRIORITY_TITLE so we know the renderer handles the
        # full real-world payload, even if most are no-data placeholders.
        for gid, name in ds.PRIORITY_TITLES:
            _seed_game(db, gid, name, 1000 + gid)
        # Only seed data for two
        _seed_window_summary(db, 134, ingest_date=date(2026, 6, 24),
                             positive=32, negative=3, neutral=42, total=77)
        _seed_window_summary(db, 24,  ingest_date=date(2026, 6, 24),
                             positive=80, negative=10, neutral=50, total=140)

        built = ds.build_weekly_digest(db, today=date(2026, 6, 24))
        html = built["html"]

        # Subject + structure
        assert "Weekly Executive Digest" in html
        assert "Jun 18 – Jun 24, 2026" in html
        # Names of all 8 priority titles are present
        for _, name in ds.PRIORITY_TITLES:
            import html as _h
            assert _h.escape(name) in html
        # Portfolio brief mentions the two with-data titles
        assert "qualifying posts" in html
        # The no-data placeholder copy
        assert "No qualifying posts in this window" in html
        # Bold-formatted recommendations rendered as strong
        assert "<strong>" in html

    def test_html_escapes_user_text(self, db):
        _seed_game(db, 24, "Warhammer 40,000: Space Marine 2", 1024)
        _seed_window_summary(
            db, 24, ingest_date=date(2026, 6, 24),
            positive=10, negative=1, neutral=5, total=16,
            exec_summary="Issue with <script>alert('xss')</script> tag.",
            rec_actions="1. Fix <iframe>",
            bold_ideas=["Use a & b together"],
        )
        built = ds.build_weekly_digest(db, today=date(2026, 6, 24))
        html = built["html"]
        # Raw <script> must not appear unescaped
        assert "<script>" not in html
        assert "&lt;script&gt;" in html
        assert "&amp;" in html  # & in bold idea got escaped


# ── Recipients / send pipeline ────────────────────────────────────────────────

class TestSend:
    """Send pipeline tests — verify Resend HTTPS path + retry semantics.

    DigitalOcean blocks outbound SMTP on droplets, so the production path
    is Resend's HTTPS API (api.resend.com:443).  Tests mock _post_to_resend
    so they never actually hit the network.
    """

    def test_no_recipients_returns_no_send(self, db, monkeypatch):
        for gid, name in ds.PRIORITY_TITLES:
            _seed_game(db, gid, name, 2000 + gid)
        result = ds.send_weekly_digest(db, today=date(2026, 6, 24))
        assert result["sent"] is False
        assert result["reason"] == "no_recipients"

    def test_no_resend_api_key_returns_not_configured(self, db, monkeypatch):
        from models import DigestRecipient
        db.add(DigestRecipient(email="a@example.com", is_active=True))
        db.commit()
        for gid, name in ds.PRIORITY_TITLES:
            _seed_game(db, gid, name, 3000 + gid)
        monkeypatch.delenv("RESEND_API_KEY", raising=False)
        result = ds.send_weekly_digest(db, today=date(2026, 6, 24))
        assert result["sent"] is False
        assert result["reason"] == "resend_not_configured"

    def test_send_succeeds_on_first_try(self, db, monkeypatch):
        """Happy path: Resend POST returns 200, only the active recipient
        is passed (inactive ones are filtered out)."""
        from unittest.mock import patch
        from models import DigestRecipient
        db.add(DigestRecipient(email="a@example.com", is_active=True))
        db.add(DigestRecipient(email="b@example.com", is_active=False))
        db.commit()
        for gid, name in ds.PRIORITY_TITLES:
            _seed_game(db, gid, name, 4000 + gid)
        monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
        with patch("services.digest_service._post_to_resend",
                   return_value={"kind": "ok", "status": 200, "body": ""}) as mock_post:
            result = ds.send_weekly_digest(db, today=date(2026, 6, 24))
        assert result["sent"] is True
        assert result["provider"] == "resend"
        # Only the active recipient is passed (3rd positional arg)
        recipients_arg = mock_post.call_args[0][3]
        assert recipients_arg == ["a@example.com"]
        # And the API key from env was used
        api_key_arg = mock_post.call_args[0][0]
        assert api_key_arg == "re_test_key"
        # Only one POST attempt (no retry on success)
        assert mock_post.call_count == 1

    def test_4xx_fatal_does_not_retry(self, db, monkeypatch):
        """4xx (e.g. 401 invalid api key, 422 invalid from-address) must
        NOT be retried — those are config bugs, retrying burns API quota."""
        from unittest.mock import patch
        from models import DigestRecipient
        db.add(DigestRecipient(email="a@example.com", is_active=True))
        db.commit()
        for gid, name in ds.PRIORITY_TITLES:
            _seed_game(db, gid, name, 5000 + gid)
        monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
        with patch("services.digest_service._post_to_resend",
                   return_value={"kind": "fatal", "status": 401, "body": "unauthorized"}) as mock_post:
            result = ds.send_weekly_digest(db, today=date(2026, 6, 24))
        assert result["sent"] is False
        assert result["reason"] == "resend_fatal"
        assert "401" in result["error"]
        assert mock_post.call_count == 1  # NO retry

    def test_5xx_retries_once_and_succeeds(self, db, monkeypatch):
        """Transient 5xx → retry once → succeeds."""
        from unittest.mock import patch
        from models import DigestRecipient
        db.add(DigestRecipient(email="a@example.com", is_active=True))
        db.commit()
        for gid, name in ds.PRIORITY_TITLES:
            _seed_game(db, gid, name, 6000 + gid)
        monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
        monkeypatch.setattr("services.digest_service._RESEND_RETRY_BACKOFF_SECONDS", 0)
        results = [
            {"kind": "retryable", "status": 503, "body": "upstream"},
            {"kind": "ok", "status": 200, "body": ""},
        ]
        with patch("services.digest_service._post_to_resend",
                   side_effect=results) as mock_post:
            result = ds.send_weekly_digest(db, today=date(2026, 6, 24))
        assert result["sent"] is True
        assert result.get("retried") is True
        assert mock_post.call_count == 2

    def test_429_rate_limit_retries(self, db, monkeypatch):
        """429 is treated as retryable.  After-retry-still-failing surfaces
        as resend_transient with the status code in the error message."""
        from unittest.mock import patch
        from models import DigestRecipient
        db.add(DigestRecipient(email="a@example.com", is_active=True))
        db.commit()
        for gid, name in ds.PRIORITY_TITLES:
            _seed_game(db, gid, name, 7000 + gid)
        monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
        monkeypatch.setattr("services.digest_service._RESEND_RETRY_BACKOFF_SECONDS", 0)
        results = [
            {"kind": "retryable", "status": 429, "body": "rate limited"},
            {"kind": "retryable", "status": 429, "body": "rate limited"},
        ]
        with patch("services.digest_service._post_to_resend",
                   side_effect=results) as mock_post:
            result = ds.send_weekly_digest(db, today=date(2026, 6, 24))
        assert result["sent"] is False
        assert result["reason"] == "resend_transient"
        assert "429" in result["error"]
        assert mock_post.call_count == 2

    def test_network_error_retries_once(self, db, monkeypatch):
        """Network/DNS/TLS error → retry once."""
        from unittest.mock import patch
        from models import DigestRecipient
        db.add(DigestRecipient(email="a@example.com", is_active=True))
        db.commit()
        for gid, name in ds.PRIORITY_TITLES:
            _seed_game(db, gid, name, 8000 + gid)
        monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
        monkeypatch.setattr("services.digest_service._RESEND_RETRY_BACKOFF_SECONDS", 0)
        results = [
            {"kind": "network", "message": "dns lookup failed"},
            {"kind": "ok", "status": 200, "body": ""},
        ]
        with patch("services.digest_service._post_to_resend",
                   side_effect=results) as mock_post:
            result = ds.send_weekly_digest(db, today=date(2026, 6, 24))
        assert result["sent"] is True
        assert mock_post.call_count == 2

    def test_resend_from_env_override(self, db, monkeypatch):
        """RESEND_FROM env var must be used when set, instead of default."""
        from unittest.mock import patch
        from models import DigestRecipient
        db.add(DigestRecipient(email="a@example.com", is_active=True))
        db.commit()
        for gid, name in ds.PRIORITY_TITLES:
            _seed_game(db, gid, name, 9000 + gid)
        monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
        monkeypatch.setenv("RESEND_FROM",
                           "SentimentPulse <digest@verified.example.com>")
        with patch("services.digest_service._post_to_resend",
                   return_value={"kind": "ok", "status": 200, "body": ""}) as mock_post:
            ds.send_weekly_digest(db, today=date(2026, 6, 24))
        # 2nd positional arg is from_addr
        assert mock_post.call_args[0][1] == "SentimentPulse <digest@verified.example.com>"
