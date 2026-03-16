"""
Reddit service — subreddit discovery, post and comment fetching via PRAW.

PRAW handles its own rate limiting (1 request/second for read-only access).
All calls are wrapped in try/except so failures are logged, not raised.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

import praw
from praw.exceptions import PRAWException

from config import settings

logger = logging.getLogger(__name__)


# ── Client factory ────────────────────────────────────────────────────────────

def _get_client() -> Optional[praw.Reddit]:
    """
    Return a read-only PRAW Reddit client.
    Returns None if credentials are not configured.
    """
    if not settings.reddit_client_id or not settings.reddit_client_secret:
        logger.warning(
            "Reddit credentials not configured — skipping Reddit operations. "
            "Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env."
        )
        return None

    return praw.Reddit(
        client_id=settings.reddit_client_id,
        client_secret=settings.reddit_client_secret,
        user_agent=settings.reddit_user_agent,
        ratelimit_seconds=5,
        read_only=True,
    )


# ── Subreddit discovery ───────────────────────────────────────────────────────

def discover_subreddits(game_name: str, max_results: int = 3) -> list[str]:
    """
    Search Reddit for subreddits related to `game_name`.
    Returns a list of subreddit display names (without r/).

    Uses reddit.subreddits.search() which queries by subreddit name/description.
    """
    reddit = _get_client()
    if reddit is None:
        return []

    try:
        found = []
        for sub in reddit.subreddits.search(f"{game_name} game", limit=max_results):
            found.append(sub.display_name)
        logger.info(
            "Discovered %d subreddit(s) for '%s': %s",
            len(found), game_name, found,
        )
        return found
    except PRAWException as exc:
        logger.error(
            "PRAW error discovering subreddits for '%s': %s", game_name, exc
        )
        return []
    except Exception as exc:
        logger.error(
            "Unexpected error during subreddit discovery for '%s': %s", game_name, exc
        )
        return []


# ── Post fetching ─────────────────────────────────────────────────────────────

def fetch_subreddit_posts(
    subreddit_name: str,
    limit: int = 25,
) -> list[dict]:
    """
    Fetch `new` and `hot` posts from a subreddit, deduplicating by post ID.

    Each returned dict has:
        external_id, author, title, body, url, upvotes, post_date
    """
    reddit = _get_client()
    if reddit is None:
        return []

    try:
        sub = reddit.subreddit(subreddit_name)
        seen: dict[str, dict] = {}

        for submission in list(sub.new(limit=limit)) + list(sub.hot(limit=limit)):
            if submission.id not in seen:
                seen[submission.id] = _submission_to_dict(submission)

        posts = list(seen.values())
        logger.info(
            "Fetched %d post(s) from r/%s", len(posts), subreddit_name
        )
        return posts

    except PRAWException as exc:
        logger.error(
            "PRAW error fetching posts from r/%s: %s", subreddit_name, exc
        )
        return []
    except Exception as exc:
        logger.error(
            "Unexpected error fetching posts from r/%s: %s", subreddit_name, exc
        )
        return []


# ── Comment fetching ──────────────────────────────────────────────────────────

def fetch_post_comments(
    submission_id: str,
    limit: int = 50,
) -> list[dict]:
    """
    Fetch top-level comments from a Reddit post.

    Each returned dict has:
        external_id, author, title (None), body, url, upvotes, post_date

    Note: MoreComments objects are not expanded to avoid extra API calls.
    """
    reddit = _get_client()
    if reddit is None:
        return []

    try:
        submission = reddit.submission(id=submission_id)
        # Replace MoreComments with limit=0 to avoid extra API calls
        submission.comments.replace_more(limit=0)

        comments = []
        for comment in list(submission.comments)[:limit]:
            # Guard against MoreComments objects that slipped through
            if not hasattr(comment, "body"):
                continue
            comments.append({
                "external_id": f"comment_{comment.id}",
                "author": (
                    str(comment.author) if comment.author else "[deleted]"
                ),
                "title": None,
                "body": comment.body,
                "url": f"https://www.reddit.com{comment.permalink}",
                "upvotes": max(0, int(comment.score)),
                "post_date": datetime.fromtimestamp(
                    comment.created_utc, tz=timezone.utc
                ),
            })

        return comments

    except PRAWException as exc:
        logger.error(
            "PRAW error fetching comments for post %s: %s", submission_id, exc
        )
        return []
    except Exception as exc:
        logger.error(
            "Unexpected error fetching comments for post %s: %s",
            submission_id, exc,
        )
        return []


# ── Private helpers ───────────────────────────────────────────────────────────

def _submission_to_dict(submission) -> dict:
    """Convert a PRAW Submission object to our standard post dict."""
    return {
        "external_id": submission.id,
        "author": (
            str(submission.author) if submission.author else "[deleted]"
        ),
        "title": submission.title,
        "body": submission.selftext or "",
        "url": f"https://www.reddit.com{submission.permalink}",
        "upvotes": max(0, int(submission.score)),
        "post_date": datetime.fromtimestamp(
            submission.created_utc, tz=timezone.utc
        ),
    }
