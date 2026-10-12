"""Import SignalPulse's TikTok comment feed into SentimentPulse.

Independent from SignalPulse's own per-title collection toggle. This consumer
has its own per-title flag: AppSetting tiktok_comment_enabled:<game_id>=true
(or TIKTOK_COMMENT_ENABLED for global). Comments only enter SentimentPulse
for Games whose own flag is on.

Enable with AppSetting tiktok_comment_enabled:<game_id>=true per title, or
tiktok_comment_enabled=true (global default). Auth comes from AppSetting
tiktok_feed_ops_token or INGESTION_OPS_TOKEN. The EnsembleData token stays
in SignalPulse; this consumer never needs it.
"""
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import requests

from models import AppSetting, RawPost, SourceEnum

EPOCH = "1970-01-01T00:00:00.000Z"
PAGE_LIMIT = 500
MAX_PAGES_PER_GAME = 100
MAX_SECONDS_PER_GAME = 120


def comment_is_focused(text, game):
    """Preserve raw comments, but keep obvious solicitation out of sentiment."""
    from services.post_relevance import is_comment_focused_on_game
    if re.search(r"\b(check (out )?my channel|subscribe to me|dm me|whatsapp|telegram|"
                 r"crypto investment|guaranteed profit|earn money|giveaway winner)\b", text, re.I):
        return False
    return is_comment_focused_on_game(text, game)


def _dt(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("feed timestamp must include timezone")
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


def _iso(value):
    return value.replace(tzinfo=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _setting(db, key, default=""):
    row = db.get(AppSetting, key)
    return row.value if row and row.value is not None else default


def import_enabled_for_game(db, game):
    """Per-title gate. Falls back to global default when the per-title key is absent."""
    key = f"tiktok_comment_enabled:{game.id}"
    per = _setting(db, key)
    if per:
        return per.lower() == "true"
    return import_enabled_global(db)


def import_enabled_global(db):
    return _setting(db, "tiktok_comment_enabled", os.getenv("TIKTOK_COMMENT_ENABLED", "false")).lower() == "true"


def feed_options(db):
    base = _setting(db, "tiktok_feed_base_url", os.getenv("TIKTOK_FEED_BASE_URL", "http://127.0.0.1:5000")).rstrip("/")
    parsed = urlparse(base)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("invalid TikTok feed base URL")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")):
        raise ValueError("TikTok feed requires HTTPS except on loopback")
    token = _setting(db, "tiktok_feed_ops_token", os.getenv("INGESTION_OPS_TOKEN", "")).strip()
    if not token:
        raise ValueError("TikTok feed ops token is not configured")
    return base, token


def import_game_comments(db, game, *, get=requests.get, max_pages=MAX_PAGES_PER_GAME,
                         max_seconds=MAX_SECONDS_PER_GAME):
    """Fetch and commit bounded pages; raise on errors without losing progress.

    collected_at is the producer's fetchedAt for this source. Original comment
    publication date remains in post_date. Comment text has NO age-based purge.
    Tombstones archive/exclude rows without erasing their stored text. The
    video's desc is provenance only, not sentiment input.
    """
    base, token = feed_options(db)
    key = f"tiktok_feed_cursor:{game.id}:{game.steam_app_id}"
    state = json.loads(_setting(db, key, "{}"))
    since = state.get("since", EPOCH)
    cursor = state.get("cursor")
    until = state.get("until")
    deleted_since = state.get("deletedSince", EPOCH)
    if bool(cursor) != bool(until):
        raise ValueError("TikTok saved cursor and snapshot must be paired")
    if max_pages < 1 or max_seconds <= 0:
        raise ValueError("TikTok import budgets must be positive")
    resuming_saved_snapshot = bool(cursor)
    started = time.monotonic()
    counts = {"inserted": 0, "updated": 0, "excluded": 0, "fetched": 0, "pages": 0,
              "complete": False, "snapshots_completed": 0, "completed_through": None,
              "stop_reason": "page_budget"}
    for _ in range(max_pages):
        if time.monotonic() - started >= max_seconds:
            counts["stop_reason"] = "time_budget"
            break
        params = {"since": since, "steamAppId": str(game.steam_app_id), "limit": PAGE_LIMIT,
                  "deletedSince": deleted_since}
        if cursor:
            params["cursor"] = cursor
        if until:
            params["until"] = until
        response = get(f"{base}/api/tiktok/ops/comments-feed", params=params,
                       headers={"x-ops-token": token}, timeout=(5, 30), allow_redirects=False)
        if response.status_code != 200:
            raise RuntimeError(f"TikTok feed HTTP {response.status_code}; cursor retained")
        page = response.json()
        if page.get("feedVersion") != 1 or page.get("source") != "tiktok_comment":
            raise ValueError("unsupported TikTok comment feed")
        snapshot = page["snapshotAt"]
        _dt(snapshot)
        if until and until != snapshot:
            raise ValueError("TikTok feed changed snapshot during pagination")
        until = snapshot
        next_cursor = page.get("nextCursor")
        if next_cursor and next_cursor == cursor:
            raise ValueError("TikTok feed cursor did not advance")
        page_counts = {"inserted": 0, "updated": 0, "excluded": 0}
        try:
            for item in page["comments"]:
                if str(item["steamAppId"]) != str(game.steam_app_id):
                    raise ValueError("TikTok feed returned a different title")
                cid = str(item["commentId"])
                if not cid or len(cid) > 247:
                    raise ValueError("invalid TikTok comment ID")
                external = "tiktok:" + cid
                fetched = _dt(item["fetchedAt"])
                published = _dt(item["createTime"])  # epoch seconds -> ISO in feed.ts
                if fetched > _dt(snapshot):
                    raise ValueError("comment is newer than feed snapshot")
                post = db.query(RawPost).filter_by(source=SourceEnum.tiktok_comment, external_id=external).first()
                if post and post.game_id != game.id:
                    raise ValueError("TikTok comment ownership conflict")
                if post and post.collected_at > fetched:
                    continue
                text = item["text"]
                if not isinstance(text, str):
                    raise ValueError("invalid TikTok comment text")
                if post is None:
                    post = RawPost(game_id=game.id, source=SourceEnum.tiktok_comment,
                                   external_id=external, is_relevant=None,
                                   relevance_tier="signal", matched_keywords=["verified_tiktok_video"],
                                   is_off_topic_drift=False)
                    db.add(post)
                    page_counts["inserted"] += 1
                elif post.body != text or post.relevance_tier == "noise":
                    if post.sentiment_record is not None:
                        db.delete(post.sentiment_record)
                        db.flush()
                        post.sentiment_record = None
                    post.is_relevant = None
                    post.is_off_topic_drift = False
                    page_counts["updated"] += 1
                post.relevance_tier = "signal"
                post.matched_keywords = ["verified_tiktok_video"]
                post.title = str(item.get("videoDesc") or "")[:500]
                post.body = text
                post.author = item.get("authorUniqueId")
                post.url = item.get("url")
                post.parent_external_id = ("tiktok:" + str(item["parentId"])) if item.get("parentId") else ("tiktok-video:" + str(item["awemeId"]))
                post.upvotes = max(0, int(item.get("likeCount") or 0))
                post.collected_at = fetched
                post.post_date = published
                db.flush()

            for tomb in page["tombstones"]:
                if str(tomb["steam_app_id"]) != str(game.steam_app_id):
                    raise ValueError("deletion belongs to a different title")
                post = db.query(RawPost).filter_by(
                    source=SourceEnum.tiktok_comment, external_id="tiktok:" + tomb["cid"],
                    game_id=game.id).first()
                if post and post.collected_at <= _dt(tomb["deleted_at"]):
                    if post.relevance_tier != "noise":
                        page_counts["excluded"] += 1
                    if post.sentiment_record is not None:
                        db.delete(post.sentiment_record)
                        db.flush()
                        post.sentiment_record = None
                    post.is_relevant = False
                    post.is_off_topic_drift = True
                    post.relevance_tier = "noise"
                    post.matched_keywords = ["tiktok_excluded:" + str(tomb.get("reason", "upstream_removal"))]
            cursor_row = db.get(AppSetting, key)
            if cursor_row is None:
                cursor_row = AppSetting(key=key)
                db.add(cursor_row)
            if next_cursor:
                new_state = {"since": since, "until": until, "cursor": next_cursor, "deletedSince": deleted_since}
            else:
                watermark = _iso(_dt(snapshot) - timedelta(seconds=1))
                new_state = {"since": watermark, "deletedSince": watermark}
            cursor_row.value = json.dumps(new_state)
            db.commit()
        except Exception:
            db.rollback()
            raise
        for name, value in page_counts.items():
            counts[name] += value
        counts["fetched"] += len(page["comments"])
        counts["pages"] += 1
        if not next_cursor:
            counts["snapshots_completed"] += 1
            counts["completed_through"] = snapshot
            if resuming_saved_snapshot:
                since = new_state["since"]
                deleted_since = new_state["deletedSince"]
            cursor = None
            until = None
    else:
        counts["stop_reason"] = "complete"
    counts["complete"] = not cursor
    return counts
