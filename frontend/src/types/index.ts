// ── Shared ────────────────────────────────────────────────────────────────────

export type Period = 'today' | 'weekly' | 'monthly' | 'quarterly' | 'lifetime'
export type Sentiment = 'positive' | 'negative' | 'neutral'
export type Source = 'steam_review' | 'steam_forum' | 'reddit' | 'bluesky'
export type TrendDirection = 'rising' | 'falling' | 'stable'
export type VelocityDirection = 'improving' | 'stable' | 'declining'

// ── Publisher ─────────────────────────────────────────────────────────────────

export interface Publisher {
  id: number
  name: string
  created_at: string
}

// ── Games ─────────────────────────────────────────────────────────────────────

export interface Game {
  id: number
  publisher_id: number
  steam_app_id: number
  name: string
  release_date: string | null
  is_active: boolean
  subreddits: string[] | null
  created_at: string
}

export interface GameDetail extends Game {
  latest_summary: DailySummary | null
}

// ── Daily Summaries ───────────────────────────────────────────────────────────

export interface DailySummary {
  id: number
  game_id: number
  summary_date: string
  positive_count: number
  negative_count: number
  neutral_count: number
  top_positive_topics: string[] | null
  top_negative_topics: string[] | null
  top_neutral_topics: string[] | null
  sentiment_trend_delta: number | null
  executive_summary: string | null
  recommended_actions: string | null
  created_at: string
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export interface SentimentCounts {
  positive: number
  negative: number
  neutral: number
  total: number
  positive_pct: number
  negative_pct: number
  neutral_pct: number
  pos_neg_ratio: number | null
}

export interface NetSentimentPoint {
  summary_date: string
  net_sentiment: number
  positive_count: number
  negative_count: number
  neutral_count: number
  total: number
}

export interface TopicItem {
  topic_label: string
  mention_count: number
  trend_direction: TrendDirection
  velocity: number
}

export interface VolumePoint {
  day: string
  steam_review: number
  steam_forum: number
  reddit: number
  bluesky: number
  total: number
}

export interface SentimentVelocity {
  direction: VelocityDirection
  delta_avg: number | null
}

export interface DashboardData {
  game_id: number
  period: string
  sentiment_today: SentimentCounts
  net_sentiment_trend: NetSentimentPoint[]
  top_positive_topics: TopicItem[]
  top_negative_topics: TopicItem[]
  top_neutral_topics: TopicItem[]
  volume_by_source: VolumePoint[]
  sentiment_velocity: SentimentVelocity
}

// ── Topic Trends ──────────────────────────────────────────────────────────────

export interface TopicTrend {
  id: number
  game_id: number
  topic_label: string
  sentiment: Sentiment
  first_seen: string
  last_seen: string
  mention_count: number
  trend_direction: TrendDirection
  velocity: number
}

// ── Raw Posts ─────────────────────────────────────────────────────────────────

export interface PostSentimentInfo {
  sentiment: Sentiment
  sentiment_score: number
  topics: string[] | null
}

export interface RawPost {
  id: number
  game_id: number
  source: Source
  external_id: string
  author: string | null
  title: string | null
  body: string | null
  url: string | null
  upvotes: number
  collected_at: string
  post_date: string | null
  sentiment_info: PostSentimentInfo | null
}

export interface PostsPage {
  items: RawPost[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

// ── Monthly Summaries ─────────────────────────────────────────────────────────

export interface MonthlySummary {
  id: number
  game_id: number
  period_year: number
  period_month: number
  positive_count: number
  negative_count: number
  neutral_count: number
  total_posts: number
  top_positive_topics: string[] | null
  top_negative_topics: string[] | null
  top_neutral_topics: string[] | null
  executive_summary: string | null
  recommended_actions: string | null
  bold_ideas: string[] | null
  generated_at: string
  month_label: string
}

// ── Window Summaries ─────────────────────────────────────────────────────────

export interface WindowSummary {
  id: number
  game_id: number
  window_days: number
  ingest_date: string
  positive_count: number
  negative_count: number
  neutral_count: number
  total_posts: number
  top_positive_topics: string[] | null
  top_negative_topics: string[] | null
  top_neutral_topics: string[] | null
  executive_summary: string | null
  recommended_actions: string | null
  bold_ideas: string[] | null
  generated_at: string
}

// ── Ingestion ─────────────────────────────────────────────────────────────────

export interface IngestStatus {
  is_running: boolean
  last_run_at: string | null
  last_run_status: string
  last_run_errors: string[]
  games_processed: number
  posts_collected: number
  next_run_at: string | null
}

export interface IngestRunResult {
  status: string
  games_processed: number
  posts_collected: number
  errors: string[]
}
