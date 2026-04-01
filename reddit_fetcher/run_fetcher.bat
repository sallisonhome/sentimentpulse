@echo off
echo Running SentimentPulse Reddit Fetcher...
cd /d "%~dp0"
python fetch_and_upload.py
echo.
pause
