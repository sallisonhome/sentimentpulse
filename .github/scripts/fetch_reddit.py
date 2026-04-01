"""
Fetch Reddit posts for all Saber Interactive game subreddits.
Runs on GitHub Actions (not blocked by Reddit).
Saves results to reddit_data.json for the droplet to consume.
"""
import json
import time
import httpx
import os
from datetime import datetime, timezone

# Same subreddit mapping as fix_subreddits.py
# Format: game_id -> (game_name, [subreddits], is_general_sub_list)
GAME_SUBREDDITS = {
    1:   ("Docked", ["gaming", "pcgaming"], True),
    2:   ("Tempest Rising", ["TempestRising"], False),
    3:   ("A Quiet Place: The Road Ahead", ["AQuietPlace", "gaming"], True),
    4:   ("The Knightling", ["gaming", "pcgaming"], True),
    5:   ("Dakar Desert Rally", ["dakardesertrally", "DakartheGame"], False),
    20:  ("Untitled John Wick Game", ["JohnWick", "gaming"], True),
    21:  ("Clive Barker's Hellraiser: Revival", ["hellraiser", "gaming"], True),
    22:  ("Jurassic Park: Survival", ["JurassicPark", "gaming"], True),
    23:  ("Turok: Origins", ["Turok", "gaming"], True),
    24:  ("Warhammer 40,000: Space Marine 2", ["Spacemarine", "SpaceMarine_2"], False),
    25:  ("John Carpenter's Toxic Commando", ["gaming", "pcgaming"], True),
    26:  ("Halo: The Master Chief Collection", ["halo", "HaloMCC"], True),
    27:  ("SnowRunner", ["snowrunner"], False),
    28:  ("RoadCraft", ["gaming", "pcgaming"], True),
    29:  ("Gloomhaven", ["Gloomhaven"], False),
    33:  ("Expeditions: A MudRunner Game", ["Mudrunner", "snowrunner"], False),
    36:  ("MudRunner", ["Mudrunner"], False),
    37:  ("Crysis 3 Remastered", ["Crysis"], False),
    39:  ("Crysis 2 Remastered", ["Crysis"], False),
    43:  ("Ghostbusters: The Video Game Remastered", ["GhostbustersGame", "ghostbusters"], True),
    60:  ("TimeShift", ["gaming"], True),
    87:  ("MX Nitro: Unleashed", ["gaming"], True),
    98:  ("Inversion", ["gaming"], True),
    104: ("Halo 2: Anniversary", ["halo", "HaloMCC"], True),
    105: ("Halo 3", ["halo", "HaloMCC"], True),
    123: ("MudRunner - Old-timers DLC", ["Mudrunner", "snowrunner"], False),
    124: ("RoadCraft - Reclaim Expansion", ["gaming"], True),
}

GENERAL_SUBS = {
    "gaming", "games", "pcgaming", "ps5", "xbox", "steam",
    "halo", "ghostbusters", "jurassicpark", "hellraiser", "johnwick",
    "patientgamers", "shouldibuythisgame",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0",
    "Accept": "application/json",
}

BASE = "https://www.reddit.com"


def game_search_query(game_name: str) -> str:
    if "'s " in game_name:
        game_name = game_name.split("'s ", 1)[1]
    return game_name.strip()


def post_mentions_game(post: dict, query: str) -> bool:
    stop = {"the", "and", "for", "with", "from", "this", "that", "have",
            "game", "games", "just", "your", "more", "about", "like"}
    text = ((post.get("title") or "") + " " + (post.get("body") or "")).lower()
    for word in query.lower().split():
        word = word.strip("':,-.")
        if len(word) >= 4 and word not in stop and word in text:
            return True
    return False


def fetch_subreddit(sub_name: str, game_name: str, limit: int = 100) -> list[dict]:
    """Fetch posts from a subreddit via Reddit JSON (works on GitHub Actions)."""
    is_general = sub_name.lower() in {s.lower() for s in GENERAL_SUBS}
    seen = {}

    if game_name and is_general:
        query = game_search_query(game_name)
        for sort in ("new", "relevance"):
            try:
                resp = httpx.get(
                    f"{BASE}/r/{sub_name}/search.json",
                    params={"q": query, "sort": sort, "limit": limit, "restrict_sr": 1, "raw_json": 1},
                    headers=HEADERS, timeout=15, follow_redirects=True,
                )
                time.sleep(2)
                if resp.status_code != 200:
                    print(f"  HTTP {resp.status_code} for r/{sub_name} search ({sort})")
                    continue
                data = resp.json()
                for child in data.get("data", {}).get("children", []):
                    post = child.get("data", {})
                    pid = post.get("id")
                    if pid and pid not in seen:
                        pd = _to_dict(post)
                        if post_mentions_game(pd, query):
                            seen[pid] = pd
            except Exception as e:
                print(f"  Error fetching r/{sub_name}: {e}")
    else:
        for feed in ("new", "hot"):
            try:
                resp = httpx.get(
                    f"{BASE}/r/{sub_name}/{feed}.json",
                    params={"limit": limit, "raw_json": 1},
                    headers=HEADERS, timeout=15, follow_redirects=True,
                )
                time.sleep(2)
                if resp.status_code != 200:
                    print(f"  HTTP {resp.status_code} for r/{sub_name}/{feed}")
                    continue
                data = resp.json()
                for child in data.get("data", {}).get("children", []):
                    post = child.get("data", {})
                    pid = post.get("id")
                    if pid and pid not in seen:
                        seen[pid] = _to_dict(post)
            except Exception as e:
                print(f"  Error fetching r/{sub_name}/{feed}: {e}")

    return list(seen.values())


def _to_dict(post: dict) -> dict:
    created = post.get("created_utc", 0)
    return {
        "external_id": post.get("id", ""),
        "author": post.get("author", "[deleted]"),
        "title": post.get("title", ""),
        "body": (post.get("selftext", "") or "")[:2000],
        "url": f"{BASE}{post.get('permalink', '')}",
        "upvotes": max(0, int(post.get("score", 0))),
        "post_date": datetime.fromtimestamp(float(created), tz=timezone.utc).isoformat() if created else None,
    }


def main():
    all_data = {}
    for game_id, (game_name, subs, _) in GAME_SUBREDDITS.items():
        game_posts = []
        seen_ids = set()
        for sub in subs:
            print(f"Fetching r/{sub} for '{game_name}' (game_id={game_id})...")
            posts = fetch_subreddit(sub, game_name)
            for p in posts:
                if p["external_id"] not in seen_ids:
                    seen_ids.add(p["external_id"])
                    game_posts.append(p)
            print(f"  Got {len(posts)} posts from r/{sub}")

        if game_posts:
            all_data[str(game_id)] = {
                "game_name": game_name,
                "posts": game_posts,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
            }
            print(f"  Total unique: {len(game_posts)} for '{game_name}'")

    output_path = os.path.join(os.path.dirname(__file__), "..", "..", "reddit_data.json")
    with open(output_path, "w") as f:
        json.dump(all_data, f)
    
    total = sum(len(v["posts"]) for v in all_data.values())
    print(f"\nDone. {total} total posts for {len(all_data)} games saved to reddit_data.json")


if __name__ == "__main__":
    main()
