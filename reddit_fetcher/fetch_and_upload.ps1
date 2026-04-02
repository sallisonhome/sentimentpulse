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

# Game ID -> (Name, Subreddits, IsGeneral)
$GAMES = @{
    "1"   = @{ Name="Docked"; Subs=@("gaming","pcgaming"); General=$true }
    "2"   = @{ Name="Tempest Rising"; Subs=@("TempestRising"); General=$false }
    "3"   = @{ Name="A Quiet Place: The Road Ahead"; Subs=@("AQuietPlace","gaming"); General=$true }
    "4"   = @{ Name="The Knightling"; Subs=@("gaming","pcgaming"); General=$true }
    "5"   = @{ Name="Dakar Desert Rally"; Subs=@("dakardesertrally","DakartheGame"); General=$false }
    "20"  = @{ Name="Untitled John Wick Game"; Subs=@("JohnWick","gaming"); General=$true }
    "21"  = @{ Name="Clive Barker's Hellraiser: Revival"; Subs=@("hellraiser","gaming"); General=$true }
    "22"  = @{ Name="Jurassic Park: Survival"; Subs=@("JurassicPark","gaming"); General=$true }
    "23"  = @{ Name="Turok: Origins"; Subs=@("Turok","gaming"); General=$true }
    "24"  = @{ Name="Warhammer 40,000: Space Marine 2"; Subs=@("Spacemarine","SpaceMarine_2"); General=$false }
    "25"  = @{ Name="John Carpenter's Toxic Commando"; Subs=@("gaming","pcgaming"); General=$true }
    "26"  = @{ Name="Halo: The Master Chief Collection"; Subs=@("halo","HaloMCC"); General=$true }
    "27"  = @{ Name="SnowRunner"; Subs=@("snowrunner"); General=$false }
    "28"  = @{ Name="RoadCraft"; Subs=@("gaming","pcgaming"); General=$true }
    "29"  = @{ Name="Gloomhaven"; Subs=@("Gloomhaven"); General=$false }
    "33"  = @{ Name="Expeditions: A MudRunner Game"; Subs=@("Mudrunner","snowrunner"); General=$false }
    "36"  = @{ Name="MudRunner"; Subs=@("Mudrunner"); General=$false }
    "37"  = @{ Name="Crysis 3 Remastered"; Subs=@("Crysis"); General=$false }
    "39"  = @{ Name="Crysis 2 Remastered"; Subs=@("Crysis"); General=$false }
    "43"  = @{ Name="Ghostbusters: The Video Game Remastered"; Subs=@("GhostbustersGame","ghostbusters"); General=$true }
    "60"  = @{ Name="TimeShift"; Subs=@("gaming"); General=$true }
    "87"  = @{ Name="MX Nitro: Unleashed"; Subs=@("gaming"); General=$true }
    "98"  = @{ Name="Inversion"; Subs=@("gaming"); General=$true }
    "104" = @{ Name="Halo 2: Anniversary"; Subs=@("halo","HaloMCC"); General=$true }
    "105" = @{ Name="Halo 3"; Subs=@("halo","HaloMCC"); General=$true }
    "123" = @{ Name="MudRunner - Old-timers DLC"; Subs=@("Mudrunner","snowrunner"); General=$false }
    "124" = @{ Name="RoadCraft - Reclaim Expansion"; Subs=@("gaming"); General=$true }
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
                $pid = $post.id
                if ($pid -and -not $seen.ContainsKey($pid)) {
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
                        $seen[$pid] = $pd
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
                $pid = $post.id
                if ($pid -and -not $seen.ContainsKey($pid)) {
                    $seen[$pid] = @{
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
        $jsonContent = $allData | ConvertTo-Json -Depth 10 -Compress
        $body = @{
            files = @{
                "reddit_data.json" = @{ content = $jsonContent }
            }
        } | ConvertTo-Json -Depth 5

        try {
            $headers = @{
                "Authorization" = "token $GIST_TOKEN"
                "Accept" = "application/vnd.github.v3+json"
            }
            Invoke-RestMethod -Uri "https://api.github.com/gists/$GIST_ID" -Method Patch -Headers $headers -Body $body -ContentType "application/json"
            Write-Host "`n  Gist updated: https://gist.github.com/$GIST_ID" -ForegroundColor Green
        } catch {
            Write-Host "`n  Failed to update Gist: $_" -ForegroundColor Red
        }
    }
} else {
    Write-Host "`n  No posts fetched -- skipping upload."
}

Write-Host "`nDone."
