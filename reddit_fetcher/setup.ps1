# SentimentPulse Reddit Fetcher — One-Time Setup
# Run this once on a new PC to configure the fetcher and Task Scheduler.
#
# Usage: powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = "Stop"

Write-Host "============================================================"
Write-Host "  SentimentPulse Reddit Fetcher Setup"
Write-Host "============================================================"
Write-Host ""

# ── 1. Get GitHub token ──────────────────────────────────────────────────────
Write-Host "You need a GitHub Personal Access Token with 'gist' scope."
Write-Host "Create one at: https://github.com/settings/tokens/new"
Write-Host "  - Check only the 'gist' scope"
Write-Host ""
$token = Read-Host "Paste your GitHub token"

if (-not $token -or $token.Length -lt 10) {
    Write-Host "Invalid token. Exiting." -ForegroundColor Red
    exit 1
}

# ── 2. Write token into the fetcher script ───────────────────────────────────
$scriptPath = Join-Path $PSScriptRoot "fetch_and_upload.ps1"
$content = Get-Content $scriptPath -Raw
$content = $content.Replace('PASTE_YOUR_GITHUB_TOKEN_HERE', $token)
Set-Content -Path $scriptPath -Value $content -Encoding UTF8
Write-Host "  Token saved to fetch_and_upload.ps1" -ForegroundColor Green

# ── 3. Test the fetcher ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "Testing connection to Reddit..." -NoNewline
try {
    $test = Invoke-RestMethod -Uri "https://www.reddit.com/r/gaming/new.json?limit=1" -UseBasicParsing -TimeoutSec 10
    Write-Host " OK" -ForegroundColor Green
} catch {
    Write-Host " WARNING: Reddit returned an error. The fetcher may still work." -ForegroundColor Yellow
}

# ── 4. Create Task Scheduler task ────────────────────────────────────────────
Write-Host ""
Write-Host "Setting up daily Task Scheduler job (10:00 AM)..."

$taskName = "SP Reddit Fetcher"

# Remove existing task if present
try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}

$action = New-ScheduledTaskAction `
    -Execute "powershell" `
    -Argument "-ExecutionPolicy Bypass -File `"$scriptPath`"" `
    -WorkingDirectory $PSScriptRoot

$trigger = New-ScheduledTaskTrigger -Daily -At "10:00AM"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -WakeToRun

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Fetches Reddit data for SentimentPulse and uploads to GitHub Gist" `
    -RunLevel Highest | Out-Null

Write-Host "  Task '$taskName' created — runs daily at 10:00 AM" -ForegroundColor Green
Write-Host "  Wake from sleep: enabled" -ForegroundColor Green
Write-Host "  Run if missed: enabled" -ForegroundColor Green

# ── 5. Done ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================"
Write-Host "  Setup complete!"
Write-Host ""
Write-Host "  To test now:  powershell -ExecutionPolicy Bypass -File fetch_and_upload.ps1"
Write-Host "  Task runs daily at 10:00 AM automatically."
Write-Host "  Droplet ingests at 10:45 AM from the Gist."
Write-Host "============================================================"
