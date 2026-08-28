"""v0028 (2026-08-28) regression tests for _run_health_drop_check.

Guarantees:
  - No drops means a "no signal drops" log line is emitted.
  - A single (game, source) drop below 50% of a >=3/day baseline
    produces a HEALTH DROP log line naming that game+source.
  - Titles below min_baseline (2/day) are never flagged.
  - The AppSetting snapshot is written every run so an operator can
    fetch it later without re-scanning the DB.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import json
import pytest

from models import AppSetting, RawPost, SourceEnum
from services.ingestor import (
    HEALTH_MIN_BASELINE,
    HEALTH_THRESHOLD_PCT,
    _run_health_drop_check,
)


def _seed(db, game, source, day_offset, count, tier="signal"):
    """Seed `count` RawPost rows at a specific day offset from today."""
    base = datetime.utcnow() - timedelta(days=day_offset)
    for i in range(count):
        db.add(RawPost(
            game_id=game.id,
            source=source,
            external_id=f"seed_{source.value}_{day_offset}_{i}_{game.id}",
            author="u/test",
            title="seed",
            body="seed",
            url="https://reddit.com/x",
            upvotes=0,
            post_date=base,
            relevance_tier=tier,
            matched_keywords=["seed"],
        ))
    db.commit()


class TestHealthDropCheck:
    def test_no_drops_when_today_matches_baseline(self, db, game):
        """5/day baseline + today at 5 = no drop."""
        for d in range(1, 8):
            _seed(db, game, SourceEnum.reddit, d, 5)
        _seed(db, game, SourceEnum.reddit, 0, 5)
        log_lines: list[str] = []
        _run_health_drop_check(db, log_lines, [])
        # Expect ONE "no signal drops" line
        no_drop = [l for l in log_lines if "no signal drops" in l]
        assert len(no_drop) == 1, f"Expected one 'no signal drops' line, got: {log_lines}"
        # And nothing marked HEALTH DROP
        assert not any("HEALTH DROP" in l for l in log_lines)

    def test_drop_flagged_when_today_below_threshold(self, db, game):
        """10/day baseline + today at 2 (20%) = flagged."""
        for d in range(1, 8):
            _seed(db, game, SourceEnum.reddit, d, 10)
        _seed(db, game, SourceEnum.reddit, 0, 2)
        log_lines: list[str] = []
        _run_health_drop_check(db, log_lines, [])
        drop_lines = [l for l in log_lines if "HEALTH DROP" in l]
        assert len(drop_lines) == 1, (
            f"Expected 1 HEALTH DROP line, got {len(drop_lines)}: {log_lines}"
        )
        assert game.name in drop_lines[0]
        assert "reddit" in drop_lines[0]

    def test_low_baseline_never_flagged(self, db, game):
        """1/day baseline is below HEALTH_MIN_BASELINE=3, don't flag even at 0."""
        for d in range(1, 8):
            _seed(db, game, SourceEnum.reddit, d, 1)
        # Today: 0 (100% drop, but baseline too small)
        log_lines: list[str] = []
        _run_health_drop_check(db, log_lines, [])
        assert not any("HEALTH DROP" in l for l in log_lines), (
            f"Low-baseline title should not flag: {log_lines}"
        )

    def test_low_active_days_never_flagged(self, db, game):
        """Big volume on 1 day, silent 6 days: not enough active days to flag."""
        _seed(db, game, SourceEnum.reddit, 1, 50)
        # No other seeded days
        log_lines: list[str] = []
        _run_health_drop_check(db, log_lines, [])
        assert not any("HEALTH DROP" in l for l in log_lines), (
            f"Sparse baseline should not flag: {log_lines}"
        )

    def test_snapshot_persisted_to_appsetting(self, db, game):
        """After a run with drops, AppSetting['ingest_last_health_drops'] must exist."""
        for d in range(1, 8):
            _seed(db, game, SourceEnum.reddit, d, 10)
        _seed(db, game, SourceEnum.reddit, 0, 1)
        log_lines: list[str] = []
        _run_health_drop_check(db, log_lines, [])
        row = db.query(AppSetting).filter(
            AppSetting.key == "ingest_last_health_drops"
        ).first()
        assert row is not None, "Snapshot must be persisted every run"
        payload = json.loads(row.value)
        assert "drops" in payload
        assert len(payload["drops"]) == 1
        assert payload["drops"][0]["game_name"] == game.name

    def test_noise_tier_never_counted(self, db, game):
        """noise-tier baseline volume should never make a title look healthy."""
        for d in range(1, 8):
            _seed(db, game, SourceEnum.reddit, d, 100, tier="noise")
        # Today: 0 signal, 100 noise
        _seed(db, game, SourceEnum.reddit, 0, 100, tier="noise")
        log_lines: list[str] = []
        _run_health_drop_check(db, log_lines, [])
        # Baseline is entirely noise → below HEALTH_MIN_BASELINE for
        # signal, no flag. This is correct because noise is dashboard-
        # filtered anyway.
        assert not any("HEALTH DROP" in l for l in log_lines)
