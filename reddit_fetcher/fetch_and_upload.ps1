# SentimentPulse Reddit Fetcher — PowerShell version
# Uses .NET HTTP client which Reddit doesn't block.
#
# Usage: powershell -ExecutionPolicy Bypass -File fetch_and_upload.ps1

$ErrorActionPreference = "Continue"

# ── CONFIGURATION ─────────────────────────────────────────────────────────────
$GIST_TOKEN = "PASTE_YOUR_GITHUB_TOKEN_HERE"
$GIST_ID = "18675b3d910f4555251b666a65a6874a"
# ──────────────────────────────────────────────────────────────────────────────

$BASE = "https://www.reddit.com"

# Game ID -> (Name, Subreddits)
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
    if ($gameName -match "'s ") {
        return ($gameName -split "'s ", 2)[1].Trim()
    }
    return $gameName.Trim()
}

function Test-PostMentionsGame($post, $query) {
    $stopWords = @("the","and","for","with","from","this","that","have","game","games","just","your","more","about","like")
    $text = ("$($post.title) $($post.body)").ToLower()
    foreach ($word in $query.ToLower().Split(" ")) {
        $word = $word.Trim("':,-.")
        if ($word.Length -ge 4 -and $word -notin $stopWords -and $text.Contains($word)) {
            return $true
        }
    }
    return $false
}

function Fetch-Reddit($url) {
    try {
        $response = Invoke-RestMethod -Uri $url -UseBasicParsing -TimeoutSec 15
        Start-Sleep -Seconds 2
        return $response
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        Write-Host "    HTTP $code" -NoNewline
        return $null
    }
}

function Fetch-Subreddit($subName, $gameName, $limit) {
    $isGeneral = $GENERAL_SUBS -contains $subName.ToLower()
    $seen = @{}

    if ($gameName -and $isGeneral) {
        $query = Get-SearchQuery $gameName
        foreach ($sort in @("new","relevance")) {
            $url = "$BASE/r/$subName/search.json?q=$([uri]::EscapeDataString($query))&sort=$sort&limit=$limit&restrict_sr=1&raw_json=1"
            $data = Fetch-Reddit $url
            if (-not $data) { continue }
            foreach ($child in $data.data.children) {
                $post = $child.data
                $postId = $post.id
                if ($postId -and -not $seen.ContainsKey($postId)) {
                    $pd = @{
                        external_id = $post.id
                        author = if ($post.author) { $post.author } else { "[deleted]" }
                        title = if ($post.title) { $post.title } else { "" }
                        body = if ($post.selftext) { $post.selftext.Substring(0, [Math]::Min(2000, $post.selftext.Length)) } else { "" }
                        url = "$BASE$($post.permalink)"
                        upvotes = [Math]::Max(0, [int]$post.score)
                        post_date = if ($post.created_utc) { [DateTimeOffset]::FromUnixTimeSeconds([long]$post.created_utc).ToString("o") } else { $null }
                    }
                    if (Test-PostMentionsGame $pd $query) {
                        $seen[$postId] = $pd
                    }
                }
            }
        }
    } else {
        foreach ($feed in @("new","hot")) {
            $url = "$BASE/r/$subName/$feed.json?limit=$limit&raw_json=1"
            $data = Fetch-Reddit $url
            if (-not $data) { continue }
            foreach ($child in $data.data.children) {
                $post = $child.data
                $postId = $post.id
                if ($postId -and -not $seen.ContainsKey($postId)) {
                    $seen[$postId] = @{
                        external_id = $post.id
                        author = if ($post.author) { $post.author } else { "[deleted]" }
                        title = if ($post.title) { $post.title } else { "" }
                        body = if ($post.selftext) { $post.selftext.Substring(0, [Math]::Min(2000, $post.selftext.Length)) } else { "" }
                        url = "$BASE$($post.permalink)"
                        upvotes = [Math]::Max(0, [int]$post.score)
                        post_date = if ($post.created_utc) { [DateTimeOffset]::FromUnixTimeSeconds([long]$post.created_utc).ToString("o") } else { $null }
                    }
                }
            }
        }
    }

    return @($seen.Values)
}

# ── MAIN ──────────────────────────────────────────────────────────────────────
Write-Host "============================================================"
Write-Host "  SentimentPulse Reddit Fetcher (PowerShell)"
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

Write-Host ""
Write-Host "  Total: $totalPosts posts for $($allData.Count) games"

if ($totalPosts -gt 0) {
    if ($GIST_TOKEN -eq "PASTE_YOUR_GITHUB_TOKEN_HERE") {
        Write-Host "`n  ERROR: Set GIST_TOKEN in the script first!" -ForegroundColor Red
    } else {
        # Save JSON without BOM (critical — BOM breaks the droplet's JSON parser)
        $tempFile = Join-Path $PSScriptRoot "reddit_data.json"
        $json = $allData | ConvertTo-Json -Depth 10 -Compress
        [System.IO.File]::WriteAllText($tempFile, $json, (New-Object System.Text.UTF8Encoding $false))

        # Upload via GitHub API (avoids gh gist edit interactive prompts)
        try {
            # Read file and escape for JSON embedding
            $content = [System.IO.File]::ReadAllText($tempFile)
            
            # Use multipart approach: update gist via API with proper escaping
            $headers = @{
                "Authorization" = "token $GIST_TOKEN"
                "Accept" = "application/vnd.github.v3+json"
            }
            
            # Build body using .NET to handle escaping properly
            $bodyObj = @{
                files = @{
                    "reddit_data.json" = @{
                        content = $content
                    }
                }
            }
            $bodyJson = $bodyObj | ConvertTo-Json -Depth 5 -Compress
            $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)
            
            Invoke-WebRequest -Uri "https://api.github.com/gists/$GIST_ID" `
                -Method Patch -Headers $headers `
                -Body $bodyBytes `
                -ContentType "application/json; charset=utf-8" `
                -UseBasicParsing | Out-Null
            
            Write-Host "`n  Gist updated successfully" -ForegroundColor Green
        } catch {
            Write-Host "`n  API upload failed: $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "  Trying gh CLI fallback..." -ForegroundColor Yellow
            try {
                # Fallback to gh CLI
                gh gist edit $GIST_ID -f reddit_data.json $tempFile 2>&1 | Out-Null
                Write-Host "  Gist updated via gh CLI" -ForegroundColor Green
            } catch {
                Write-Host "  Both upload methods failed: $($_.Exception.Message)" -ForegroundColor Red
                Write-Host "  Data saved locally: $tempFile" -ForegroundColor Yellow
            }
        }
    }
} else {
    Write-Host "`n  No posts fetched -- skipping upload."
}

Write-Host "`nDone."
