"""Import SignalPulse's verified-video comment feed into SentimentPulse.

No publisher or parent/child filter: the caller passes every active Game.
Steam app ID identifies the owner. A competitor's comments stay under that
competitor, never under its Saber parent. Cursor + page rows commit together.

Enable with AppSetting youtube_import_enabled=true (or YOUTUBE_IMPORT_ENABLED).
Auth comes from AppSetting youtube_feed_ops_token or INGESTION_OPS_TOKEN.
The YouTube API key stays in SignalPulse; this consumer never needs it.
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


def import_enabled(db):
    return _setting(db, "youtube_import_enabled", os.getenv("YOUTUBE_IMPORT_ENABLED", "false")).lower() == "true"


def feed_options(db):
    base = _setting(db, "youtube_feed_base_url", os.getenv("YOUTUBE_FEED_BASE_URL", "http://127.0.0.1:5000")).rstrip("/")
    parsed = urlparse(base)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("invalid YouTube feed base URL")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")):
        raise ValueError("YouTube feed requires HTTPS except on loopback")
    token = _setting(db, "youtube_feed_ops_token", os.getenv("INGESTION_OPS_TOKEN", "")).strip()
    if not token:
        raise ValueError("YouTube feed ops token is not configured")
    return base, token


def import_game_comments(db, game, *, get=requests.get, max_pages=MAX_PAGES_PER_GAME,
                         max_seconds=MAX_SECONDS_PER_GAME):
    """Fetch and commit bounded pages; raise on errors without losing progress.

    collected_at is the producer's fetchedAt for this source. Original comment
    publication date remains in post_date. Comment text has NO age-based
    purge. Tombstones archive/exclude rows without erasing their stored text.
    The video's title is provenance only, not sentiment input.
    """
    base, token = feed_options(db)
    key = f"youtube_feed_cursor:{game.id}:{game.steam_app_id}"
    state = json.loads(_setting(db, key, "{}"))
    since = state.get("since", EPOCH)
    cursor = state.get("cursor")
    until = state.get("until")
    deleted_since = state.get("deletedSince", EPOCH)
    if bool(cursor) != bool(until):
        raise ValueError("YouTube saved cursor and snapshot must be paired")
    if max_pages < 1 or max_seconds <= 0:
        raise ValueError("YouTube import budgets must be positive")
    # A saved pagination window is immutable, but it is NOT current coverage.
    # Finish it, then open exactly one fresh producer window in this call.
    resuming_saved_snapshot = bool(cursor)
    started = time.monotonic()
    counts = {"inserted": 0, "updated": 0, "excluded": 0, "fetched": 0, "pages": 0,
              "complete": False, "snapshots_completed": 0, "completed_through": None,
              "stop_reason": "page_budget"}
    for _ in range(max_pages):
        # Check between atomic pages. An already in-flight request retains its
        # bounded (5, 30) HTTP timeout and commits with its checkpoint.
        if time.monotonic() - started >= max_seconds:
            counts["stop_reason"] = "time_budget"
            break
        params = {"since": since, "steamAppId": str(game.steam_app_id), "limit": PAGE_LIMIT,
                  "deletedSince": deleted_since}
        if cursor:
            params["cursor"] = cursor
        if until:
            params["until"] = until
        response = get(f"{base}/api/youtube/ops/comments-feed", params=params,
                       headers={"x-ops-token": token}, timeout=(5, 30), allow_redirects=False)
        if response.status_code != 200:
            # Do not print headers, token, response body, or a requests exception
            # that might contain a configured URL with sensitive components.
            raise RuntimeError(f"YouTube feed HTTP {response.status_code}; cursor retained")
        page = response.json()
        if page.get("feedVersion") != 2 or page.get("source") != "youtube_comment":
            raise ValueError("unsupported YouTube comment feed")
        snapshot = page["snapshotAt"]
        _dt(snapshot)
        if until and until != snapshot:
            raise ValueError("YouTube feed changed snapshot during pagination")
        until = snapshot
        next_cursor = page.get("nextCursor")
        if next_cursor and next_cursor == cursor:
            raise ValueError("YouTube feed cursor did not advance")
        page_counts = {"inserted": 0, "updated": 0, "excluded": 0}
        try:
            for item in page["comments"]:
                if str(item["steamAppId"]) != str(game.steam_app_id):
                    raise ValueError("YouTube feed returned a different title")
                cid = str(item["commentId"])
                if not cid or len(cid) > 247:
                    raise ValueError("invalid YouTube comment ID")
                external = "youtube:" + cid
                fetched = _dt(item["fetchedAt"])
                published = _dt(item["publishedAt"])
                if fetched > _dt(snapshot):
                    raise ValueError("comment is newer than feed snapshot")
                post = db.query(RawPost).filter_by(source=SourceEnum.youtube_comment, external_id=external).first()
                if post and post.game_id != game.id:
                    raise ValueError("YouTube comment ownership conflict")
                if post and post.collected_at > fetched:
                    continue
                text = item["text"]
                if not isinstance(text, str):
                    raise ValueError("invalid YouTube comment text")
                if post is None:
                    post = RawPost(game_id=game.id, source=SourceEnum.youtube_comment,
                                   external_id=external, is_relevant=None,
                                   relevance_tier="signal", matched_keywords=["verified_youtube_video"],
                                   is_off_topic_drift=False)
                    db.add(post)
                    page_counts["inserted"] += 1
                elif post.body != text or post.relevance_tier == "noise":
                    # Edits invalidate the old sentiment, not just the displayed
                    # body. Step 5 will classify the replacement comment text.
                    if post.sentiment_record is not None:
                        db.delete(post.sentiment_record)
                        db.flush()
                        post.sentiment_record = None
                    post.is_relevant = None
                    post.is_off_topic_drift = False
                    page_counts["updated"] += 1
                post.relevance_tier = "signal"
                post.matched_keywords = ["verified_youtube_video"]
                post.title = str(item.get("videoTitle") or "")[:500]
                post.body = text
                post.author = item.get("authorChannelId")
                post.url = f"https://www.youtube.com/watch?v={item['videoId']}&lc={cid}"
                post.parent_external_id = ("youtube:" + str(item["parentId"])) if item.get("parentId") else ("youtube-video:" + str(item["videoId"]))
                post.upvotes = max(0, int(item.get("likeCount") or 0))
                post.collected_at = fetched
                post.post_date = published
                db.flush()  # also dedup repeated IDs within the same page

            for tomb in page["tombstones"]:
                if str(tomb["steam_app_id"]) != str(game.steam_app_id):
                    raise ValueError("deletion belongs to a different title")
                post = db.query(RawPost).filter_by(
                    source=SourceEnum.youtube_comment, external_id="youtube:" + tomb["comment_id"],
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
                    post.matched_keywords = ["youtube_excluded:" + str(tomb.get("reason", "upstream_removal"))]
            cursor_row = db.get(AppSetting, key)
            if cursor_row is None:
                cursor_row = AppSetting(key=key)
                db.add(cursor_row)
            if next_cursor:
                new_state = {"since": since, "until": until, "cursor": next_cursor, "deletedSince": deleted_since}
            else:
                # One-second overlap handles equal-timestamp ties and retries.
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
                # Old-window checkpoint has committed. If the next request
                # fails or the budget expires, a later run starts fresh from
                # this watermark, never reports the old snapshot as current.
                since = new_state["since"]
                deleted_since = new_state["deletedSince"]
                cursor = None
                until = None
                resuming_saved_snapshot = False
                continue
            counts["complete"] = True
            counts["stop_reason"] = "current_snapshot_complete"
            break
        cursor = next_cursor
    return counts
