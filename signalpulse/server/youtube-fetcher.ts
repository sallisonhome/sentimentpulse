/**
 * YouTube Video Data Fetcher
 * 
 * Extracts video IDs from URLs, fetches metadata via oEmbed (no API key),
 * and optionally uses YouTube Data API v3 for richer data.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VideoData {
  videoId: string;
  title: string;
  channelName: string;
  viewCount: number | null;
  thumbnailUrl: string;
  publishedAt?: string;
}

interface OEmbedResponse {
  title: string;
  author_name: string;
  author_url: string;
  thumbnail_url: string;
  thumbnail_width: number;
  thumbnail_height: number;
}

interface YouTubeApiSnippet {
  title: string;
  channelTitle: string;
  publishedAt: string;
  thumbnails: {
    default?: { url: string };
    medium?: { url: string };
    high?: { url: string };
  };
}

interface YouTubeApiStatistics {
  viewCount: string;
  likeCount: string;
  commentCount: string;
}

interface YouTubeApiResponse {
  items: Array<{
    id: string;
    snippet: YouTubeApiSnippet;
    statistics: YouTubeApiStatistics;
  }>;
}

// ─── Video ID Extraction ─────────────────────────────────────────────────────

/**
 * Extract a YouTube video ID from various URL formats:
 * - https://www.youtube.com/watch?v=VIDEO_ID
 * - https://youtu.be/VIDEO_ID
 * - https://www.youtube.com/embed/VIDEO_ID
 * - https://www.youtube.com/v/VIDEO_ID
 * - https://m.youtube.com/watch?v=VIDEO_ID
 */
export function extractVideoId(url: string): string | null {
  if (!url) return null;

  try {
    const trimmed = url.trim();

    // youtu.be/VIDEO_ID
    const shortMatch = trimmed.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (shortMatch) return shortMatch[1];

    // youtube.com/watch?v=VIDEO_ID (works for www, m, music subdomains)
    const watchMatch = trimmed.match(/youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/);
    if (watchMatch) return watchMatch[1];

    // youtube.com/embed/VIDEO_ID
    const embedMatch = trimmed.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
    if (embedMatch) return embedMatch[1];

    // youtube.com/v/VIDEO_ID
    const vMatch = trimmed.match(/youtube\.com\/v\/([a-zA-Z0-9_-]{11})/);
    if (vMatch) return vMatch[1];

    return null;
  } catch {
    return null;
  }
}

// ─── Public Data Fetching (No API Key) ───────────────────────────────────────

/**
 * Fetch video metadata from YouTube's public oEmbed endpoint.
 * Returns title, channel name, and thumbnail URL.
 * No API key required.
 */
export async function fetchVideoInfoPublic(videoId: string): Promise<{
  title: string;
  channelName: string;
  thumbnailUrl: string;
}> {
  const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;

  const response = await fetch(oembedUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`oEmbed request failed: ${response.status} ${response.statusText}`);
  }

  const data: OEmbedResponse = await response.json();

  return {
    title: data.title,
    channelName: data.author_name,
    thumbnailUrl: data.thumbnail_url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
  };
}

/**
 * Fetch view count by reading the public YouTube watch page HTML.
 * Extracts viewCount from the embedded JSON data in the page source.
 * Returns null if extraction fails.
 */
export async function fetchViewCountPublic(videoId: string): Promise<number | null> {
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const response = await fetch(watchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) {
      console.warn(`YouTube page fetch failed: ${response.status}`);
      return null;
    }

    const html = await response.text();

    // Look for "viewCount":"NNNN" in the embedded JSON
    const viewCountMatch = html.match(/"viewCount"\s*:\s*"(\d+)"/);
    if (viewCountMatch) {
      return parseInt(viewCountMatch[1], 10);
    }

    // Fallback: try meta tag
    const metaMatch = html.match(/<meta\s+itemprop="interactionCount"\s+content="(\d+)"/);
    if (metaMatch) {
      return parseInt(metaMatch[1], 10);
    }

    console.warn(`Could not extract view count for video ${videoId}`);
    return null;
  } catch (err) {
    console.warn(`Error fetching view count for ${videoId}:`, err);
    return null;
  }
}

// ─── API Key Fetching (Optional) ─────────────────────────────────────────────

/**
 * Fetch video info + view count via YouTube Data API v3.
 * Requires a valid API key.
 */
export async function fetchVideoInfoApi(videoId: string, apiKey: string): Promise<{
  title: string;
  channelName: string;
  viewCount: number;
  thumbnailUrl: string;
  publishedAt: string;
}> {
  const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoId}&key=${apiKey}`;

  const response = await fetch(apiUrl);

  if (!response.ok) {
    throw new Error(`YouTube API request failed: ${response.status} ${response.statusText}`);
  }

  const data: YouTubeApiResponse = await response.json();

  if (!data.items || data.items.length === 0) {
    throw new Error(`Video not found: ${videoId}`);
  }

  const item = data.items[0];
  const snippet = item.snippet;
  const stats = item.statistics;

  return {
    title: snippet.title,
    channelName: snippet.channelTitle,
    viewCount: parseInt(stats.viewCount, 10) || 0,
    thumbnailUrl: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    publishedAt: snippet.publishedAt,
  };
}

// ─── Main Fetcher ────────────────────────────────────────────────────────────

/**
 * Main function: tries YouTube API first (if key available), falls back to public endpoints.
 * Always returns a VideoData object.
 */
export async function fetchVideoData(videoId: string, apiKey?: string): Promise<VideoData> {
  // If API key is available, try API first
  if (apiKey && apiKey.trim().length > 0) {
    try {
      const apiData = await fetchVideoInfoApi(videoId, apiKey);
      return {
        videoId,
        title: apiData.title,
        channelName: apiData.channelName,
        viewCount: apiData.viewCount,
        thumbnailUrl: apiData.thumbnailUrl,
        publishedAt: apiData.publishedAt,
      };
    } catch (err) {
      console.warn(`YouTube API fetch failed, falling back to public:`, err);
      // Fall through to public fetch
    }
  }

  // Public fetch (no API key needed)
  const [info, viewCount] = await Promise.all([
    fetchVideoInfoPublic(videoId),
    fetchViewCountPublic(videoId),
  ]);

  return {
    videoId,
    title: info.title,
    channelName: info.channelName,
    viewCount: viewCount,
    thumbnailUrl: info.thumbnailUrl,
  };
}
