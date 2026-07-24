"""
One-time script — persists the approved 29-game distinctive_keywords lists
from /home/user/workspace/sentiment_relevance_fix/proposed_keywords.json to
the live `games` table.

Usage:
    cd backend
    python scripts/apply_keyword_lists.py                 # apply
    python scripts/apply_keyword_lists.py --dry-run        # preview only
    python scripts/apply_keyword_lists.py --keywords-file /path/to/other.json

Idempotent: running it twice produces the same end state (an UPDATE that
sets the same list again is a no-op). Safe to call from the deploy workflow
on every deploy — the AppSetting row `keyword_lists_applied_at` should be
used by the CALLER (deploy.yml) to skip re-running this after the first
successful deploy, but the script itself is also safe to re-run manually at
any time.

Do NOT run this against the live/production DB from a workspace/sandbox
context — the deploy workflow runs it against the droplet's DB.
"""
import argparse
import json
import logging
import sys
from pathlib import Path

# Add backend directory to sys.path so absolute imports work when run
# directly as `python scripts/apply_keyword_lists.py` from within backend/.
sys.path.insert(0, str(Path(__file__).parent.parent))

from database import SessionLocal  # noqa: E402
from models import Game  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s")
logger = logging.getLogger(__name__)

DEFAULT_KEYWORDS_FILE = "/home/user/workspace/sentiment_relevance_fix/proposed_keywords.json"


def apply_keyword_lists(keywords_file: str = DEFAULT_KEYWORDS_FILE, dry_run: bool = False) -> dict:
    """
    Reads {game_id: [keywords...]} from `keywords_file` and UPDATEs
    games.distinctive_keywords for each game_id found in the DB.

    Returns a summary dict: {"changed": int, "unchanged": int, "not_found": [ids]}.
    """
    path = Path(keywords_file)
    if not path.exists():
        raise FileNotFoundError(f"Keywords file not found: {keywords_file}")

    with open(path, "r", encoding="utf-8") as f:
        keyword_map: dict[str, list[str]] = json.load(f)

    db = SessionLocal()
    changed = 0
    unchanged = 0
    not_found: list[str] = []

    try:
        for game_id_str, keywords in keyword_map.items():
            try:
                game_id = int(game_id_str)
            except ValueError:
                logger.warning("Skipping non-integer game id key %r in keywords file.", game_id_str)
                continue

            game = db.query(Game).filter(Game.id == game_id).first()
            if game is None:
                not_found.append(game_id_str)
                logger.warning("game_id=%s from keywords file not found in DB — skipping.", game_id_str)
                continue

            if game.distinctive_keywords == keywords:
                unchanged += 1
                continue

            logger.info(
                "game_id=%d name=%r: %d -> %d keyword(s)%s",
                game.id, game.name,
                len(game.distinctive_keywords or []), len(keywords),
                " [DRY RUN]" if dry_run else "",
            )
            if not dry_run:
                game.distinctive_keywords = keywords
            changed += 1

        if not dry_run:
            db.commit()
        else:
            db.rollback()

    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    summary = {"changed": changed, "unchanged": unchanged, "not_found": not_found}
    logger.info(
        "apply_keyword_lists complete: %d changed, %d unchanged, %d not found (%s).%s",
        changed, unchanged, len(not_found), not_found,
        " [DRY RUN — no changes committed]" if dry_run else "",
    )
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--keywords-file", default=DEFAULT_KEYWORDS_FILE,
        help=f"Path to the {{game_id: [keywords]}} JSON file (default: {DEFAULT_KEYWORDS_FILE})",
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without committing.")
    args = parser.parse_args()

    summary = apply_keyword_lists(keywords_file=args.keywords_file, dry_run=args.dry_run)
    if summary["not_found"]:
        sys.exit(1)  # non-zero exit so CI/deploy logs flag it, even though changes still applied


if __name__ == "__main__":
    main()
