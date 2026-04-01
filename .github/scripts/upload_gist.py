"""
Upload reddit_data.json to a GitHub Gist so the droplet can fetch it.
Requires GIST_TOKEN and GIST_ID environment variables.
"""
import json
import os
import httpx

GIST_TOKEN = os.environ.get("GIST_TOKEN", "")
GIST_ID = os.environ.get("GIST_ID", "")

if not GIST_TOKEN or not GIST_ID:
    print("GIST_TOKEN or GIST_ID not set — skipping upload")
    exit(0)

data_path = os.path.join(os.path.dirname(__file__), "..", "..", "reddit_data.json")
with open(data_path) as f:
    content = f.read()

resp = httpx.patch(
    f"https://api.github.com/gists/{GIST_ID}",
    headers={
        "Authorization": f"token {GIST_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
    },
    json={
        "files": {
            "reddit_data.json": {"content": content}
        }
    },
    timeout=30,
)

if resp.status_code == 200:
    print(f"Gist updated successfully: https://gist.github.com/{GIST_ID}")
else:
    print(f"Failed to update gist: HTTP {resp.status_code}")
    print(resp.text[:500])
    exit(1)
