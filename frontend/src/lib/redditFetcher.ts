/**
 * Reddit Fetcher — runs in the user's browser (residential IP, not blocked).
 * Fetches posts from configured subreddits via Reddit's public JSON API,
 * then POSTs results to the droplet's /api/reddit/upload endpoint.
 */

const BASE = 'https://www.reddit.com'
const DELAY_MS = 2000  // 2s between requests to avoid rate limiting

const GENERAL_SUBS = new Set([
  'gaming', 'games', 'pcgaming', 'ps5', 'xbox', 'steam',
  'halo', 'ghostbusters', 'jurassicpark', 'hellraiser', 'johnwick',
  'patientgamers', 'shouldibuythisgame',
])

interface GameConfig {
  name: string
  subs: string[]
}

// Same mapping as the PowerShell script
const GAMES: Record<string, GameConfig> = {
  '1':   { name: 'Docked', subs: ['gaming', 'pcgaming'] },
  '2':   { name: 'Tempest Rising', subs: ['TempestRising'] },
  '3':   { name: 'A Quiet Place: The Road Ahead', subs: ['AQuietPlace', 'gaming'] },
  '4':   { name: 'The Knightling', subs: ['gaming', 'pcgaming'] },
  '5':   { name: 'Dakar Desert Rally', subs: ['dakardesertrally', 'DakartheGame'] },
  '20':  { name: 'Untitled John Wick Game', subs: ['JohnWick', 'gaming'] },
  '21':  { name: "Clive Barker's Hellraiser: Revival", subs: ['hellraiser', 'gaming'] },
  '22':  { name: 'Jurassic Park: Survival', subs: ['JurassicPark', 'gaming'] },
  '23':  { name: 'Turok: Origins', subs: ['Turok', 'gaming'] },
  '24':  { name: 'Warhammer 40,000: Space Marine 2', subs: ['Spacemarine', 'SpaceMarine_2'] },
  '25':  { name: "John Carpenter's Toxic Commando", subs: ['gaming', 'pcgaming'] },
  '26':  { name: 'Halo: The Master Chief Collection', subs: ['halo', 'HaloMCC'] },
  '27':  { name: 'SnowRunner', subs: ['snowrunner'] },
  '28':  { name: 'RoadCraft', subs: ['gaming', 'pcgaming'] },
  '29':  { name: 'Gloomhaven', subs: ['Gloomhaven'] },
  '33':  { name: 'Expeditions: A MudRunner Game', subs: ['Mudrunner', 'snowrunner'] },
  '36':  { name: 'MudRunner', subs: ['Mudrunner'] },
  '37':  { name: 'Crysis 3 Remastered', subs: ['Crysis'] },
  '39':  { name: 'Crysis 2 Remastered', subs: ['Crysis'] },
  '43':  { name: 'Ghostbusters: The Video Game Remastered', subs: ['GhostbustersGame', 'ghostbusters'] },
  '60':  { name: 'TimeShift', subs: ['gaming'] },
  '87':  { name: 'MX Nitro: Unleashed', subs: ['gaming'] },
  '98':  { name: 'Inversion', subs: ['gaming'] },
  '104': { name: 'Halo 2: Anniversary', subs: ['halo', 'HaloMCC'] },
  '105': { name: 'Halo 3', subs: ['halo', 'HaloMCC'] },
  '123': { name: 'MudRunner - Old-timers DLC', subs: ['Mudrunner', 'snowrunner'] },
  '124': { name: 'RoadCraft - Reclaim Expansion', subs: ['gaming'] },
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'game', 'games', 'just', 'your', 'more', 'about', 'like'])

function gameSearchQuery(name: string): string {
  if (name.includes("'s ")) return name.split("'s ")[1].trim()
  return name.trim()
}

function postMentionsGame(title: string, body: string, query: string): boolean {
  const text = `${title} ${body}`.toLowerCase()
  for (const word of query.toLowerCase().split(' ')) {
    const w = word.replace(/[':,\-.]/g, '')
    if (w.length >= 4 && !STOP_WORDS.has(w) && text.includes(w)) return true
  }
  return false
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface RedditPost {
  external_id: string
  author: string
  title: string
  body: string
  url: string
  upvotes: number
  post_date: string | null
}

async function fetchRedditJson(url: string): Promise<any | null> {
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

async function fetchSubreddit(subName: string, gameName: string): Promise<RedditPost[]> {
  const isGeneral = GENERAL_SUBS.has(subName.toLowerCase())
  const seen = new Map<string, RedditPost>()

  if (gameName && isGeneral) {
    const query = gameSearchQuery(gameName)
    for (const sort of ['new', 'relevance']) {
      const url = `${BASE}/r/${subName}/search.json?q=${encodeURIComponent(query)}&sort=${sort}&limit=100&restrict_sr=1&raw_json=1`
      const data = await fetchRedditJson(url)
      await delay(DELAY_MS)
      if (!data?.data?.children) continue
      for (const child of data.data.children) {
        const post = child.data
        if (!post?.id || seen.has(post.id)) continue
        const pd: RedditPost = {
          external_id: post.id,
          author: post.author || '[deleted]',
          title: post.title || '',
          body: (post.selftext || '').slice(0, 2000),
          url: `${BASE}${post.permalink || ''}`,
          upvotes: Math.max(0, post.score || 0),
          post_date: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
        }
        if (postMentionsGame(pd.title, pd.body, query)) {
          seen.set(post.id, pd)
        }
      }
    }
  } else {
    for (const feed of ['new', 'hot']) {
      const url = `${BASE}/r/${subName}/${feed}.json?limit=100&raw_json=1`
      const data = await fetchRedditJson(url)
      await delay(DELAY_MS)
      if (!data?.data?.children) continue
      for (const child of data.data.children) {
        const post = child.data
        if (!post?.id || seen.has(post.id)) continue
        seen.set(post.id, {
          external_id: post.id,
          author: post.author || '[deleted]',
          title: post.title || '',
          body: (post.selftext || '').slice(0, 2000),
          url: `${BASE}${post.permalink || ''}`,
          upvotes: Math.max(0, post.score || 0),
          post_date: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
        })
      }
    }
  }

  return Array.from(seen.values())
}

export interface FetchProgress {
  current: number
  total: number
  currentGame: string
  totalPosts: number
}

export type ProgressCallback = (progress: FetchProgress) => void

export async function fetchAllRedditData(onProgress?: ProgressCallback): Promise<{
  data: Record<string, { game_name: string; posts: RedditPost[]; fetched_at: string }>
  totalPosts: number
}> {
  const allData: Record<string, { game_name: string; posts: RedditPost[]; fetched_at: string }> = {}
  let totalPosts = 0
  const gameIds = Object.keys(GAMES).sort((a, b) => parseInt(a) - parseInt(b))
  const total = gameIds.length

  for (let i = 0; i < gameIds.length; i++) {
    const gameId = gameIds[i]
    const game = GAMES[gameId]
    const seenIds = new Set<string>()
    const gamePosts: RedditPost[] = []

    onProgress?.({ current: i + 1, total, currentGame: game.name, totalPosts })

    for (const sub of game.subs) {
      const posts = await fetchSubreddit(sub, game.name)
      for (const p of posts) {
        if (!seenIds.has(p.external_id)) {
          seenIds.add(p.external_id)
          gamePosts.push(p)
        }
      }
    }

    if (gamePosts.length > 0) {
      allData[gameId] = {
        game_name: game.name,
        posts: gamePosts,
        fetched_at: new Date().toISOString(),
      }
      totalPosts += gamePosts.length
    }
  }

  return { data: allData, totalPosts }
}

export async function uploadToDroplet(data: Record<string, any>): Promise<{ new_posts: number; message: string }> {
  const resp = await fetch('/api/reddit/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!resp.ok) throw new Error(`Upload failed: HTTP ${resp.status}`)
  return resp.json()
}
