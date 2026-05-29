# SentimentPulse Reddit Fetcher — Posts directly to the droplet
# No Gist needed. Run manually whenever you want fresh Reddit data.
#
# Usage: powershell -ExecutionPolicy Bypass -File fetch_reddit.ps1

$ErrorActionPreference = "Continue"

# ── CONFIGURATION ─────────────────────────────────────────────────────────────
$DROPLET_URL = "http://104.236.239.46/api/reddit/upload"
# ──────────────────────────────────────────────────────────────────────────────

# Arctic Shift is the working Pushshift-style Reddit archive that succeeded
# Pushshift after Reddit's 2023 API policy change. Reddit itself now returns
# HTTP 403 on all anonymous .json endpoints (changed late May 2026), so the
# fetcher routes through Arctic Shift's free public API instead.
#
# Data lag: a few minutes to a few hours behind live Reddit. Acceptable for
# SentimentPulse's daily ingest. See CLAUDE.md §17 for the canonical command.
$BASE = "https://arctic-shift.photon-reddit.com/api/posts/search"
$REDDIT_BASE = "https://www.reddit.com"  # only used for building permalink URLs

$GAMES = @{
    "1"   = @{ Name="Docked"; Subs=@("gaming","pcgaming") }
    "2"   = @{ Name="Tempest Rising"; Subs=@("TempestRising") }
    "3"   = @{ Name="A Quiet Place: The Road Ahead"; Subs=@("AQuietPlace","gaming") }
    "4"   = @{ Name="The Knightling"; Subs=@("gaming","pcgaming") }
    "5"   = @{ Name="Dakar Desert Rally"; Subs=@("dakardesertrally","DakartheGame") }
    "20"  = @{ Name="Untitled John Wick Game"; Subs=@("JohnWick","gaming") }
    "21"  = @{ Name="Clive Barker's Hellraiser: Revival"; Subs=@("hellraiser","gaming") }
    "22"  = @{ Name="Jurassic Park: Survival"; Subs=@("JurassicPark","gaming") }
    "23"  = @{ Name="Turok: Origins"; Subs=@("Turok","gaming") }
    "24"  = @{ Name="Warhammer 40,000: Space Marine 2"; Subs=@("Spacemarine","SpaceMarine_2") }
    "25"  = @{ Name="John Carpenter's Toxic Commando"; Subs=@("gaming","pcgaming") }
    "26"  = @{ Name="Halo: The Master Chief Collection"; Subs=@("halo","HaloMCC") }
    "27"  = @{ Name="SnowRunner"; Subs=@("snowrunner") }
    "28"  = @{ Name="RoadCraft"; Subs=@("gaming","pcgaming") }
    "29"  = @{ Name="Gloomhaven"; Subs=@("Gloomhaven") }
    "33"  = @{ Name="Expeditions: A MudRunner Game"; Subs=@("Mudrunner","snowrunner") }
    "36"  = @{ Name="MudRunner"; Subs=@("Mudrunner") }
    "37"  = @{ Name="Crysis 3 Remastered"; Subs=@("Crysis") }
    "39"  = @{ Name="Crysis 2 Remastered"; Subs=@("Crysis") }
    "43"  = @{ Name="Ghostbusters: The Video Game Remastered"; Subs=@("GhostbustersGame","ghostbusters") }
    "60"  = @{ Name="TimeShift"; Subs=@("gaming") }
    "87"  = @{ Name="MX Nitro: Unleashed"; Subs=@("gaming") }
    "98"  = @{ Name="Inversion"; Subs=@("gaming") }
    "104" = @{ Name="Halo 2: Anniversary"; Subs=@("halo","HaloMCC") }
    "105" = @{ Name="Halo 3"; Subs=@("halo","HaloMCC") }
    "123" = @{ Name="MudRunner - Old-timers DLC"; Subs=@("Mudrunner","snowrunner") }
    "124" = @{ Name="RoadCraft - Reclaim Expansion"; Subs=@("gaming") }
}

$GENERAL_SUBS = @("gaming","games","pcgaming","ps5","xbox","steam","halo",
    "ghostbusters","jurassicpark","hellraiser","johnwick","patientgamers")

function Get-SearchQuery($gameName) {
    if ($gameName -match "'s ") { return ($gameName -split "'s ", 2)[1].Trim() }
    return $gameName.Trim()
}

function Test-PostMentionsGame($post, $query) {
    $stopWords = @("the","and","for","with","from","this","that","have","game","games","just","your","more","about","like")
    $text = ("$($post.title) $($post.body)").ToLower()
    foreach ($word in $query.ToLower().Split(" ")) {
        $word = $word.Trim("':,-.")
        if ($word.Length -ge 4 -and $word -notin $stopWords -and $text.Contains($word)) { return $true }
    }
    return $false
}

# Arctic Shift accepts plain HTTP requests; a descriptive UA is courteous.
$REDDIT_USER_AGENT = "SentimentPulse/1.0 (by /u/halfbaked)"
$REDDIT_HEADERS = @{
    "User-Agent" = $REDDIT_USER_AGENT
    "Accept"     = "application/json"
}

# We use curl.exe (ships with Windows 10/11 by default at
# C:\Windows\System32\curl.exe) instead of PowerShell's Invoke-RestMethod
# because Cloudflare bot-detection fingerprints Invoke-RestMethod's TLS
# handshake / HTTP/2 negotiation and returns 403 on requests that work
# fine in browsers and curl. Verified May 29 2026 that:
#   - Arctic Shift returns 200 + JSON to a web browser from this same IP
#   - Arctic Shift returns 200 + JSON to curl from this same IP
#   - Arctic Shift returns 403 to Invoke-RestMethod from this same IP
function Fetch-Reddit($url) {
    $tempOut = [System.IO.Path]::GetTempFileName()
    try {
        # -sS: silent except for errors. -A: User-Agent. -H: extra headers.
        # -w: write the HTTP status code to stdout AFTER the body is saved.
        # --max-time: total request timeout, including connect.
        # -o: write body to temp file (separates body from status code).
        $statusCode = & curl.exe `
            -sS `
            -A $REDDIT_USER_AGENT `
            -H "Accept: application/json" `
            --max-time 15 `
            -o $tempOut `
            -w "%{http_code}" `
            $url 2>$null

        Start-Sleep -Seconds 2

        if ($statusCode -eq "200") {
            $body = Get-Content $tempOut -Raw -ErrorAction Stop
            return ($body | ConvertFrom-Json)
        } else {
            Write-Host " $statusCode" -NoNewline -ForegroundColor Yellow
            return $null
        }
    } catch {
        Write-Host " ERR" -NoNewline -ForegroundColor Yellow
        return $null
    } finally {
        if (Test-Path $tempOut) { Remove-Item $tempOut -Force -ErrorAction SilentlyContinue }
    }
}

# Convert a single Arctic Shift / Reddit-format post row to our payload shape.
function ConvertTo-PostPayload($post) {
    return @{
        external_id = $post.id
        author      = if ($post.author) { $post.author } else { "[deleted]" }
        title       = if ($post.title) { $post.title } else { "" }
        body        = if ($post.selftext) {
                          $post.selftext.Substring(0, [Math]::Min(2000, $post.selftext.Length))
                      } else { "" }
        url         = "$REDDIT_BASE$($post.permalink)"
        upvotes     = [Math]::Max(0, [int]$post.score)
        post_date   = if ($post.created_utc) {
                          [DateTimeOffset]::FromUnixTimeSeconds([long]$post.created_utc).ToString("o")
                      } else { $null }
    }
}

function Fetch-Subreddit($subName, $gameName, $limit) {
    $isGeneral = $GENERAL_SUBS -contains $subName.ToLower()
    $seen = @{}

    if ($gameName -and $isGeneral) {
        # Keyword search inside a general subreddit (e.g. r/gaming + "John Wick").
        # Arctic Shift doesn't have a single 'q' param like Reddit's API —
        # it has SEPARATE 'title' and 'selftext' filters. We query each, merge,
        # and post-filter via Test-PostMentionsGame to mirror the original
        # relevance gate.
        $query = Get-SearchQuery $gameName
        $qEnc = [uri]::EscapeDataString($query)
        $subEnc = [uri]::EscapeDataString($subName)

        foreach ($field in @("title","selftext")) {
            $url = "$BASE`?subreddit=$subEnc&${field}=$qEnc&limit=$limit&sort=desc"
            $data = Fetch-Reddit $url
            if (-not $data -or -not $data.data) { continue }
            foreach ($post in $data.data) {
                $postId = $post.id
                if ($postId -and -not $seen.ContainsKey($postId)) {
                    $pd = ConvertTo-PostPayload $post
                    if (Test-PostMentionsGame $pd $query) { $seen[$postId] = $pd }
                }
            }
        }
    } else {
        # "New" + "hot" feed equivalents on Arctic Shift are both just
        # 'sort=desc' on created_utc. The archive doesn't have a separate 'hot'
        # signal, so we issue ONE request instead of two; this matches the
        # original script's de-dupe behavior anyway since both feeds returned
        # overlapping post sets.
        $url = "$BASE`?subreddit=$([uri]::EscapeDataString($subName))&limit=$limit&sort=desc"
        $data = Fetch-Reddit $url
        if ($data -and $data.data) {
            foreach ($post in $data.data) {
                $postId = $post.id
                if ($postId -and -not $seen.ContainsKey($postId)) {
                    $seen[$postId] = ConvertTo-PostPayload $post
                }
            }
        }
    }
    return @($seen.Values)
}

# ── MAIN ──────────────────────────────────────────────────────────────────────
Write-Host "============================================================"
Write-Host "  SentimentPulse Reddit Fetcher"
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "============================================================"

$allData = @{}
$totalPosts = 0

foreach ($gameId in $GAMES.Keys | Sort-Object { [int]$_ }) {
    $game = $GAMES[$gameId]
    $gamePosts = @()
    $seenIds = @{}

    foreach ($sub in $game.Subs) {
        Write-Host "  r/$sub for '$($game.Name)'... " -NoNewline
        $posts = Fetch-Subreddit $sub $game.Name 100
        $newCount = 0
        foreach ($p in $posts) {
            if (-not $seenIds.ContainsKey($p.external_id)) {
                $seenIds[$p.external_id] = $true
                $gamePosts += $p
                $newCount++
            }
        }
        Write-Host "$newCount posts"
    }

    if ($gamePosts.Count -gt 0) {
        $allData[$gameId] = @{
            game_name = $game.Name
            posts = $gamePosts
            fetched_at = (Get-Date).ToUniversalTime().ToString("o")
        }
        $totalPosts += $gamePosts.Count
    }
}

Write-Host "`n  Total: $totalPosts posts for $($allData.Count) games"

if ($totalPosts -gt 0) {
    Write-Host "`n  Uploading to SentimentPulse..."
    try {
        $tempFile = Join-Path $PSScriptRoot "reddit_data.json"
        $json = $allData | ConvertTo-Json -Depth 10 -Compress
        [System.IO.File]::WriteAllText($tempFile, $json, (New-Object System.Text.UTF8Encoding $false))

        $bodyBytes = [System.IO.File]::ReadAllBytes($tempFile)
        $response = Invoke-RestMethod -Uri $DROPLET_URL `
            -Method Post `
            -Body $bodyBytes `
            -ContentType "application/json; charset=utf-8" `
            -TimeoutSec 60

        Write-Host "  $($response.message)" -ForegroundColor Green
    } catch {
        Write-Host "  Upload failed: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "  Data saved locally: $tempFile" -ForegroundColor Yellow
    }
} else {
    Write-Host "`n  No posts fetched."
}

Write-Host "`nDone."
