# Reddit Fetcher (Home PC)

Runs on your home PC (residential IP — not blocked by Reddit) and uploads
Reddit data to a GitHub Gist. The DigitalOcean droplet reads the Gist
during its daily 2 AM ingestion.

## One-Time Setup

1. Install Python dependency:
   ```
   pip install httpx
   ```

2. Create a GitHub Personal Access Token:
   - Go to https://github.com/settings/tokens
   - Click "Generate new token (classic)"
   - Check the **gist** scope
   - Copy the token

3. Edit `fetch_and_upload.py` — replace `PASTE_YOUR_GITHUB_TOKEN_HERE` with your token

4. Test it:
   ```
   python fetch_and_upload.py
   ```

## Automate with Task Scheduler

1. Open **Task Scheduler** (search in Start menu)
2. Click **Create Basic Task**
3. Name: `SentimentPulse Reddit Fetcher`
4. Trigger: **Daily** at **1:30 AM**
5. Action: **Start a program**
   - Program: `python`
   - Arguments: `C:\sentimentpulse\reddit_fetcher\fetch_and_upload.py`
   - Start in: `C:\sentimentpulse\reddit_fetcher`
6. Check "Open Properties dialog" → under Conditions, uncheck "Start only if on AC power"
7. Click Finish

The droplet ingestion runs at 2:00 AM UTC and will pick up the Reddit data automatically.
