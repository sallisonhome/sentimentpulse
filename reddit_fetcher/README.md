# Reddit Fetcher (Home PC)

Runs on the user's home PC (residential IP — not blocked by Reddit) and posts
Reddit data **directly to the droplet** at `http://104.236.239.46/api/reddit/upload`.
The droplet stores the data and merges it on the next ingestion cycle.

## The ONE AND ONLY Command (CRITICAL — see CLAUDE.md §17)

```powershell
powershell -ExecutionPolicy Bypass -File "C:\sentimentpulse\reddit_fetcher\fetch_reddit.ps1"
```

This is the canonical command. **Never substitute** a Python-only invocation,
`fetch_and_upload.py`, `fetch_and_upload.ps1`, `run_fetcher.bat`, or any other
variant — those routed through a now-deprecated GitHub Gist path that Reddit
403s. They have been removed from the repo.

If the command above returns 403s, **diagnose the 403** (rate limit,
user-agent, retry-after) — do NOT substitute a different command.

## How It Works

`fetch_reddit.ps1` uses PowerShell's native `Invoke-RestMethod` (.NET HTTP
client). Reddit does not block this fingerprint from residential IPs.

1. Iterates the 26 active Saber games in `$GAMES`
2. Fetches `new` + `hot` JSON from each configured subreddit
3. For "general" subs (gaming, pcgaming, etc.) it also runs a per-game search
4. Filters posts so they actually mention the game by name
5. POSTs the consolidated payload to the droplet upload endpoint

The droplet endpoint (`backend/routers/reddit_upload.py`) accepts the payload,
deduplicates against existing `raw_posts`, and writes new rows. The next
scheduled ingestion (10:45 UTC daily) picks up the new posts for sentiment
classification and topic extraction (with §14 relevance + §15 critical-mass
gates active).

## Automate with Task Scheduler

If you want this to run automatically each morning before the droplet's
10:45 UTC ingest:

1. Open **Task Scheduler** (search in Start menu)
2. Click **Create Basic Task**
3. Name: `SentimentPulse Reddit Fetcher`
4. Trigger: **Daily** at **9:30 AM** local time (or whenever, before 10:45 UTC)
5. Action: **Start a program**
   - Program: `powershell`
   - Arguments: `-ExecutionPolicy Bypass -File "C:\sentimentpulse\reddit_fetcher\fetch_reddit.ps1"`
   - Start in: `C:\sentimentpulse\reddit_fetcher`
6. Under Conditions, uncheck "Start only if on AC power" (laptop users)
7. Under Settings, check "Run task as soon as possible after a scheduled start is missed"
8. Click Finish

## Troubleshooting

- **403 errors** → Reddit is rate-limiting your IP. Wait 15–30 minutes and
  retry. If it persists, Reddit may have updated their bot detection — open
  an issue rather than substituting a different command (see §17).
- **Droplet unreachable** → Confirm the droplet is up
  (`curl http://104.236.239.46/api/ingest/status`). The script will print the
  HTTP error if the upload fails.
- **Posts not appearing in summaries** → The droplet must run its scheduled
  ingest (10:45 UTC daily) to process newly-uploaded posts. Trigger manually
  via `POST /api/ingest/run` if needed.
