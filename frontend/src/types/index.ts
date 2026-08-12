// ── Shared ────────────────────────────────────────────────────────────────────

export type Period = 'today' | 'weekly' | 'monthly' | 'quarterly' | 'lifetime'
export type Sentiment = 'positive' | 'negative' | 'neutral'
export type Source = 'steam_review' | 'steam_forum' | 'reddit' | 'bluesky' | 'dtf'
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
  /** CLAUDE.md §21 per-title commercial-strategic positioning brief. */
  commercial_context?: string | null
  created_at: string
}

export interface GameDetail extends Game {
  latest_summary: DailySummary | null
}

// ── Competitor Games ──────────────────────────────────────────────────────────

/** Max competitors trackable under a single parent Saber title. */
export const MAX_COMPETITORS_PER_PARENT = 4

export interface CompetitorGame {
  id: number
  name: string
  steam_app_id: number
  subreddits: string[] | null
  distinctive_keywords: string[] | null
  release_date: string | null
}

// ── Competitor Timeseries (dashboard cross-title chart) ────────────────────────

export interface CompetitorTimeseriesGame {
  game_id: number
  name: string
  is_parent: boolean
  /** Period-over-period totals (2026-07-26).
   *  Populated only for 7d / 30d / 90d views — null for `today` and
   *  `lifetime` (no comparable prior window). pct_change is null when
   *  prev_total is 0 (division undefined). */
  current_total: number | null
  prev_total: number | null
  pct_change: number | null
}

export interface CompetitorTimeseriesDay {
  day: string
  /** Keyed by game_id as a string (JSON object keys are always strings). */
  counts: Record<string, number>
}

export interface CompetitorTimeseriesEvent {
  id: number
  game_id: number
  event_date: string  // YYYY-MM-DD
  name: string
}

export interface CompetitorTimeseriesResponse {
  games: CompetitorTimeseriesGame[]
  timeseries: CompetitorTimeseriesDay[]
  events?: CompetitorTimeseriesEvent[]
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
  /** v0016.2 (2026-08-12): Reddit comments ingested via Arctic Shift.
   *  Older responses may omit this field, so treat as optional client-side. */
  reddit_comment?: number
  bluesky: number
  /** DTF.ru — Russian-language gaming forum. Added 2026-07-27; older
   *  responses may omit this field, so treat as optional client-side. */
  dtf?: number
  total: number
}

export interface SentimentVelocity {
  direction: VelocityDirection
  delta_avg: number | null
}

// 2026-08-05: TopicSummary / TopTopicsSummary drive the redesigned
// dashboard Top Topics widget (concise text summary ranked by post
// volume across the selected period). The older TopicItem[] fields on
// DashboardData are retained for schema stability but are always empty
// arrays now — no UI reads them.
export interface TopicSummary {
  label:  string
  detail: string
  volume: number
}

export interface TopTopicsSummary {
  positive: TopicSummary[]
  negative: TopicSummary[]
  neutral:  TopicSummary[]
}

export interface DashboardData {
  game_id: number
  period: string
  sentiment_today: SentimentCounts
  net_sentiment_trend: NetSentimentPoint[]
  top_positive_topics: TopicItem[]
  top_negative_topics: TopicItem[]
  top_neutral_topics: TopicItem[]
  top_topics_summary: TopTopicsSummary
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

export type IngestRunStatus =
  | 'never'
  | 'success'
  | 'partial'
  | 'partial_failure'
  | 'error'

export type SourceHealth =
  | 'unknown'
  | 'skipped'
  | 'ok'
  | 'degraded'
  | 'failed'
  | 'silent'
  | 'auth_broken'

export interface IngestStatus {
  is_running: boolean
  last_run_at: string | null
  last_run_status: IngestRunStatus | string
  last_run_errors: string[]
  games_processed: number
  posts_collected: number
  next_run_at: string | null
  reddit_health: SourceHealth | string
  reddit_fetched_total: number
  reddit_retries: number
  bluesky_health?: SourceHealth | string
  bluesky_fetched_total?: number
  bluesky_retries?: number
  steam_review_health?: SourceHealth | string
  steam_review_fetched_total?: number
  steam_forum_health?: SourceHealth | string
  steam_forum_fetched_total?: number
}

export interface IngestRunResult {
  status: string
  games_processed: number
  posts_collected: number
  errors: string[]
}
