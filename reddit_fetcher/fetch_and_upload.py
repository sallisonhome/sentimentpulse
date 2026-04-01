"""
SentimentPulse Reddit Fetcher — runs on your home PC.

Fetches posts from all configured subreddits via Reddit's public JSON
(works from residential IPs) and uploads the data to a GitHub Gist
that the droplet reads during ingestion.

Setup:
  1. pip install httpx
  2. Set GIST_TOKEN below (GitHub Personal Access Token with gist scope)
  3. Run: python fetch_and_upload.py
  4. (Optional) Set up Windows Task Scheduler to run daily at 1:30 AM

The droplet's 2:00 AM ingestion will pick up the fresh data automatically.
"""
import json
import time
import httpx
import sys
from datetime import datetime, timezone

# ── CONFIGURATION ─────────────────────────────────────────────────────────────
# GitHub Personal Access Token with "gist" scope.
# Create at: https://github.com/settings/tokens → Generate new token (classic)
# Check the "gist" scope checkbox.
GIST_TOKEN = "PASTE_YOUR_GITHUB_TOKEN_HERE"
GIST_ID = "18675b3d910f4555251b666a65a6874a"
# ──────────────────────────────────────────────────────────────────────────────

GAME_SUBREDDITS = {
    1:   ("Docked", ["gaming", "pcgaming"]),
    2:   ("Tempest Rising", ["TempestRising"]),
    3:   ("A Quiet Place: The Road Ahead", ["AQuietPlace", "gaming"]),
    4:   ("The Knightling", ["gaming", "pcgaming"]),
    5:   ("Dakar Desert Rally", ["dakardesertrally", "DakartheGame"]),
    20:  ("Untitled John Wick Game", ["JohnWick", "gaming"]),
    21:  ("Clive Barker's Hellraiser: Revival", ["hellraiser", "gaming"]),
    22:  ("Jurassic Park: Survival", ["JurassicPark", "gaming"]),
    23:  ("Turok: Origins", ["Turok", "gaming"]),
    24:  ("Warhammer 40,000: Space Marine 2", ["Spacemarine", "SpaceMarine_2"]),
    25:  ("John Carpenter's Toxic Commando", ["gaming", "pcgaming"]),
    26:  ("Halo: The Master Chief Collection", ["halo", "HaloMCC"]),
    27:  ("SnowRunner", ["snowrunner"]),
    28:  ("RoadCraft", ["gaming", "pcgaming"]),
    29:  ("Gloomhaven", ["Gloomhaven"]),
    33:  ("Expeditions: A MudRunner Game", ["Mudrunner", "snowrunner"]),
    36:  ("MudRunner", ["Mudrunner"]),
    37:  ("Crysis 3 Remastered", ["Crysis"]),
    39:  ("Crysis 2 Remastered", ["Crysis"]),
    43:  ("Ghostbusters: The Video Game Remastered", ["GhostbustersGame", "ghostbusters"]),
    60:  ("TimeShift", ["gaming"]),
    87:  ("MX Nitro: Unleashed", ["gaming"]),
    98:  ("Inversion", ["gaming"]),
    104: ("Halo 2: Anniversary", ["halo", "HaloMCC"]),
    105: ("Halo 3", ["halo", "HaloMCC"]),
    123: ("MudRunner - Old-timers DLC", ["Mudrunner", "snowrunner"]),
    124: ("RoadCraft - Reclaim Expansion", ["gaming"]),
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
    is_general = sub_name.lower() in {s.lower() for s in GENERAL_SUBS}
    seen = {}

    if game_name and is_general:
        query = game_search_query(game_name)
        for sort in ("new", "relevance"):
            try:
                resp = httpx.get(
                    f"{BASE}/r/{sub_name}/search.json",
                    params={"q": query, "sort": sort, "limit": limit,
                            "restrict_sr": 1, "raw_json": 1},
                    headers=HEADERS, timeout=15, follow_redirects=True,
                )
                time.sleep(2)
                if resp.status_code != 200:
                    print(f"    HTTP {resp.status_code} for r/{sub_name} search ({sort})")
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
                print(f"    Error: {e}")
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
                    print(f"    HTTP {resp.status_code} for r/{sub_name}/{feed}")
                    continue
                data = resp.json()
                for child in data.get("data", {}).get("children", []):
                    post = child.get("data", {})
                    pid = post.get("id")
                    if pid and pid not in seen:
                        seen[pid] = _to_dict(post)
            except Exception as e:
                print(f"    Error: {e}")

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
        "post_date": datetime.fromtimestamp(
            float(created), tz=timezone.utc
        ).isoformat() if created else None,
    }


def upload_to_gist(data: dict) -> bool:
    if GIST_TOKEN == "PASTE_YOUR_GITHUB_TOKEN_HERE":
        print("\n ERROR: Set your GIST_TOKEN in the script first!")
        print("  Go to https://github.com/settings/tokens")
        print("  Generate a classic token with 'gist' scope")
        return False

    content = json.dumps(data)
    resp = httpx.patch(
        f"https://api.github.com/gists/{GIST_ID}",
        headers={
            "Authorization": f"token {GIST_TOKEN}",
            "Accept": "application/vnd.github.v3+json",
        },
        json={"files": {"reddit_data.json": {"content": content}}},
        timeout=30,
    )
    if resp.status_code == 200:
        print(f"\n Gist updated: https://gist.github.com/{GIST_ID}")
        return True
    else:
        print(f"\n Failed to update Gist: HTTP {resp.status_code}")
        print(f"  {resp.text[:300]}")
        return False


def main():
    print("=" * 60)
    print("  SentimentPulse Reddit Fetcher")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    all_data = {}
    total_posts = 0

    for game_id, (game_name, subs) in GAME_SUBREDDITS.items():
        game_posts = []
        seen_ids = set()

        for sub in subs:
            print(f"  r/{sub} for '{game_name}'...", end=" ", flush=True)
            posts = fetch_subreddit(sub, game_name)
            new = 0
            for p in posts:
                if p["external_id"] not in seen_ids:
                    seen_ids.add(p["external_id"])
                    game_posts.append(p)
                    new += 1
            print(f"{new} posts")

        if game_posts:
            all_data[str(game_id)] = {
                "game_name": game_name,
                "posts": game_posts,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
            }
            total_posts += len(game_posts)

    print(f"\n  Total: {total_posts} posts for {len(all_data)} games")

    if total_posts > 0:
        upload_to_gist(all_data)
    else:
        print("\n  No posts fetched — skipping Gist upload.")
        print("  If Reddit is blocking you, try again later.")

    print("\nDone.")


if __name__ == "__main__":
    main()
