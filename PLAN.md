# SentimentPulse — Build Plan

> **Status**: Awaiting confirmation before any code is written.
> This document lists every file, API integration, database table, and build phase for the project.

---

## 1. Directory Structure (All Files to Create)

```
sentimentpulse/
├── .env.example
├── .gitignore
├── docker-compose.yml
├── README.md
├── CLAUDE.md
├── PLAN.md
│
├── backend/
│   ├── main.py                         # FastAPI app entry point, CORS, lifespan scheduler
│   ├── database.py                     # SQLAlchemy engine + session factory; SQLite/Postgres switch
│   ├── models.py                       # All SQLAlchemy ORM models
│   ├── schemas.py                      # All Pydantic request/response models
│   ├── config.py                       # Settings via pydantic-settings (reads .env)
│   ├── requirements.txt
│   │
│   ├── routers/
│   │   ├── __init__.py
│   │   ├── publisher.py                # GET/POST /api/publisher
│   │   ├── games.py                    # GET /api/games, /api/games/{id}, /api/games/latest
│   │   ├── dashboard.py                # GET /api/games/{id}/dashboard
│   │   ├── summaries.py                # GET /api/games/{id}/summaries
│   │   ├── topics.py                   # GET /api/games/{id}/topics
│   │   ├── posts.py                    # GET /api/games/{id}/posts
│   │   └── ingest.py                   # POST /api/ingest/run, GET /api/ingest/status
│   │
│   ├── services/
│   │   ├── __init__.py
│   │   ├── steam_service.py            # Steam App List + Reviews API + Forum scraping
│   │   ├── reddit_service.py           # PRAW integration; subreddit discovery + post/comment fetch
│   │   ├── nlp_service.py              # Sentiment classification (RoBERTa + VADER fallback)
│   │   ├── topic_service.py            # BERTopic / LDA topic extraction; topic_trends upsert
│   │   ├── summary_service.py          # Claude API calls for executive summary + actions
│   │   └── ingestor.py                 # Orchestrates all 8 ingestion pipeline steps
│   │
│   ├── scheduler.py                    # APScheduler setup; registers daily 2 AM job
│   │
│   ├── migrations/
│   │   ├── env.py                      # Alembic env (reads DATABASE_URL)
│   │   ├── script.py.mako
│   │   └── versions/
│   │       └── 0001_initial_schema.py  # Initial Alembic migration
│   ├── alembic.ini
│   │
│   ├── logs/                           # Runtime log output (gitignored)
│   │   └── .gitkeep
│   │
│   └── tests/
│       ├── __init__.py
│       ├── test_nlp_service.py         # Sentiment classification pipeline test
│       ├── test_deduplication.py       # Duplicate post detection test
│       └── test_daily_summary.py       # Daily aggregation logic test
│
└── frontend/
    ├── index.html
    ├── vite.config.ts
    ├── tailwind.config.ts
    ├── tsconfig.json
    ├── tsconfig.node.json
    ├── postcss.config.js
    ├── package.json
    ├── components.json                 # shadcn/ui config
    │
    └── src/
        ├── main.tsx
        ├── App.tsx                     # Router setup (react-router-dom)
        ├── index.css                   # Tailwind directives
        │
        ├── types/
        │   └── index.ts                # All shared TypeScript interfaces
        │
        ├── lib/
        │   ├── api.ts                  # Axios/fetch client; base URL config
        │   ├── queryClient.ts          # TanStack Query client config
        │   └── utils.ts                # shadcn/ui cn() helper + misc utils
        │
        ├── hooks/
        │   ├── usePublisher.ts         # GET/POST /api/publisher
        │   ├── useGames.ts             # GET /api/games, /api/games/{id}
        │   ├── useDashboard.ts         # GET /api/games/{id}/dashboard
        │   ├── useSummaries.ts         # GET /api/games/{id}/summaries
        │   ├── useTopics.ts            # GET /api/games/{id}/topics
        │   ├── usePosts.ts             # GET /api/games/{id}/posts
        │   └── useIngest.ts            # POST /api/ingest/run, GET /api/ingest/status
        │
        ├── components/
        │   ├── layout/
        │   │   ├── AppShell.tsx        # Sidebar + top bar + main content wrapper
        │   │   ├── Sidebar.tsx         # Publisher name, game selector, settings link
        │   │   └── TopBar.tsx          # Game title, last ingestion time, Run Ingestion button
        │   │
        │   ├── shared/
        │   │   ├── PeriodFilter.tsx    # Weekly/Monthly/Quarterly/Lifetime toggle
        │   │   ├── SentimentBadge.tsx  # Positive/Negative/Neutral color badge
        │   │   ├── SkeletonCard.tsx    # Generic skeleton loader card
        │   │   ├── EmptyState.tsx      # Onboarding empty state UI
        │   │   └── ErrorBoundary.tsx   # React error boundary
        │   │
        │   ├── dashboard/
        │   │   ├── SentimentDonut.tsx      # Recharts PieChart donut
        │   │   ├── NetSentimentTrend.tsx   # Recharts LineChart
        │   │   ├── TopPositiveCard.tsx     # Top 3 positive topics
        │   │   ├── TopNegativeCard.tsx     # Top 3 negative topics (severity color)
        │   │   ├── NeutralWatchCard.tsx    # Top 3 neutral topics with drift arrows
        │   │   ├── VolumeBarChart.tsx      # Recharts stacked BarChart by source
        │   │   └── VelocityGauge.tsx       # Sentiment momentum badge/gauge
        │   │
        │   ├── summary/
        │   │   ├── ExecutiveSummaryCard.tsx    # AI summary paragraph card
        │   │   ├── RecommendedActions.tsx      # Numbered actions with color badges
        │   │   └── ConversationTable.tsx       # Expandable pos/neg/neutral tables
        │   │
        │   ├── topics/
        │   │   ├── TopicTable.tsx              # Filterable topic trends table
        │   │   └── TopicLineChart.tsx          # Recharts LineChart for top 5 topics
        │   │
        │   ├── posts/
        │   │   └── PostsTable.tsx              # Paginated raw posts browser
        │   │
        │   └── settings/
        │       ├── PublisherForm.tsx            # Publisher name input + save
        │       ├── GamesList.tsx                # Game enable/disable toggles
        │       ├── SubredditOverride.tsx        # Per-game subreddit input
        │       └── ExportButton.tsx             # CSV export trigger
        │
        └── pages/
            ├── DashboardPage.tsx           # Page 1 — KPI Overview
            ├── SummaryPage.tsx             # Page 2 — Executive Summary
            ├── TopicsPage.tsx              # Page 3 — Topic Trends
            ├── PostsPage.tsx               # Page 4 — Raw Posts Browser
            └── SettingsPage.tsx            # Settings page
```

**Total files to create: ~75**

---

## 2. Database Tables (SQLAlchemy Models + Alembic Migration)

| Table | Primary Key | Notable Columns | Constraints |
|---|---|---|---|
| `publishers` | `id` (int) | `name`, `created_at` | `name` UNIQUE |
| `games` | `id` (int) | `publisher_id` FK, `steam_app_id`, `name`, `release_date`, `is_active`, `subreddits` JSON, `created_at` | `steam_app_id` UNIQUE |
| `raw_posts` | `id` (int) | `game_id` FK, `source` enum, `external_id`, `author`, `title`, `body`, `url`, `upvotes`, `collected_at`, `post_date` | UNIQUE(`external_id`, `source`) |
| `sentiment_records` | `id` (int) | `raw_post_id` FK (unique), `sentiment` enum, `sentiment_score` float, `topics` JSON, `processed_at` | `raw_post_id` UNIQUE |
| `daily_summaries` | `id` (int) | `game_id` FK, `summary_date` date, `positive_count`, `negative_count`, `neutral_count`, `top_*_topics` JSON, `sentiment_trend_delta` float, `executive_summary` text, `recommended_actions` text, `created_at` | UNIQUE(`game_id`, `summary_date`) |
| `topic_trends` | `id` (int) | `game_id` FK, `topic_label`, `sentiment` enum, `first_seen`, `last_seen`, `mention_count`, `trend_direction` enum, `velocity` float | UNIQUE(`game_id`, `topic_label`, `sentiment`) |

**Enums**:
- `SourceEnum`: `steam_review`, `steam_forum`, `reddit`
- `SentimentEnum`: `positive`, `negative`, `neutral`
- `TrendDirectionEnum`: `rising`, `falling`, `stable`

---

## 3. API Integrations

| Service | Method | Purpose | Auth |
|---|---|---|---|
| Steam App List | `GET https://api.steampowered.com/ISteamApps/GetAppList/v2/` | Discover all games on Steam | None (public) |
| Steam Reviews | `GET https://store.steampowered.com/appreviews/{appid}?json=1` | Fetch recent reviews per game | None (public) |
| Steam Discussions | BeautifulSoup scrape of `https://steamcommunity.com/app/{appid}/discussions/` | Scrape forum threads + posts | None (public) |
| Reddit (PRAW) | PRAW Python library | Fetch subreddit posts + comments; subreddit discovery | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` |
| Anthropic Claude | `claude-3-5-haiku-latest` via `anthropic` Python SDK | Generate executive summaries + recommended actions | `ANTHROPIC_API_KEY` |
| HuggingFace Transformers | `cardiffnlp/twitter-roberta-base-sentiment-latest` | Primary sentiment classification | None (local model download) |
| VADER (nltk) | `vaderSentiment` | Fallback sentiment classifier | None (local) |

---

## 4. Environment Variables (`.env.example`)

```
# Reddit API
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USER_AGENT=SentimentPulse/1.0

# Anthropic
ANTHROPIC_API_KEY=

# Database (leave blank for SQLite default)
DATABASE_URL=

# Optional: pre-seed publisher name
PUBLISHER_NAME=
```

---

## 5. FastAPI Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/publisher` | Get current publisher config |
| POST | `/api/publisher` | Set publisher name; triggers game discovery |
| GET | `/api/games` | List all games with metadata |
| GET | `/api/games/latest` | Most recently released game |
| GET | `/api/games/{game_id}` | Single game detail + latest summary |
| GET | `/api/games/{game_id}/dashboard` | All KPI data (charts, cards) |
| GET | `/api/games/{game_id}/summaries` | Daily summaries; `?period=weekly\|monthly\|quarterly\|lifetime` |
| GET | `/api/games/{game_id}/topics` | Topic trends; `?period=...&direction=rising\|falling\|stable` |
| GET | `/api/games/{game_id}/posts` | Raw posts; `?sentiment=...&source=...&page=...&page_size=50` |
| POST | `/api/ingest/run` | Manually trigger full ingestion pipeline |
| GET | `/api/ingest/status` | Last run timestamp, status, next scheduled run |

---

## 6. Build Phases (Ordered)

| Phase | Scope | Key Files |
|---|---|---|
| **1** | Project scaffolding | `.env.example`, `.gitignore`, `docker-compose.yml`, `CLAUDE.md`, `README.md` (stub), `requirements.txt`, `package.json` |
| **2** | Database | `models.py`, `database.py`, `config.py`, `alembic.ini`, `migrations/env.py`, `0001_initial_schema.py` |
| **3** | Backend services | `steam_service.py`, `reddit_service.py`, `nlp_service.py`, `topic_service.py` |
| **4** | Ingestion pipeline | `ingestor.py`, `scheduler.py` |
| **5** | FastAPI routers | `main.py`, `schemas.py`, all files in `routers/` |
| **6** | Summary generation | `summary_service.py` (Claude API prompts) |
| **7** | React scaffolding | Vite setup, `App.tsx`, routing, layout shell, shared components, all hooks |
| **8** | Dashboard page | All `components/dashboard/` components + `DashboardPage.tsx` |
| **9** | Executive Summary page | All `components/summary/` components + `SummaryPage.tsx` |
| **10** | Topic Trends + Raw Posts pages | `components/topics/`, `components/posts/`, `TopicsPage.tsx`, `PostsPage.tsx` |
| **11** | Settings + period filter | `components/settings/`, `SettingsPage.tsx`, `PeriodFilter.tsx` wired globally |
| **12** | Tests + README + review | `tests/test_nlp_service.py`, `test_deduplication.py`, `test_daily_summary.py`, full `README.md` |

---

## 7. Key Technical Decisions

- **SQLite default**: `sqlite:///./sentimentpulse.db` — switches to any SQLAlchemy-compatible URL via `DATABASE_URL` env var.
- **NLP fallback chain**: Try to load `cardiffnlp/twitter-roberta-base-sentiment-latest` on startup; if model download fails or CUDA unavailable for inference, fall back to VADER silently and log a warning.
- **BERTopic vs LDA**: Use BERTopic when `bertopic` is importable; fall back to sklearn LDA with a try/except to avoid hard dependency failure.
- **Deduplication**: `UNIQUE(external_id, source)` constraint at DB level + pre-check in ingestor to avoid wasted NLP processing.
- **Subreddit discovery**: Reddit search API via PRAW (`reddit.subreddits.search(f"{game_name} game")`), take top 3 results, store as JSON in `games.subreddits`.
- **Claude API**: Use `anthropic` SDK with `client.messages.create()`; prompts templated in `summary_service.py`; responses parsed as plain text.
- **React Query**: All API calls wrapped in custom hooks using `useQuery` / `useMutation`; stale time 5 minutes; retry 2.
- **Period filter**: Stored in React context; passed as query param to all hooks automatically.
- **Docker**: `docker-compose.yml` runs `backend` (uvicorn) and `frontend` (vite dev or nginx static) services; optional `postgres` service toggled by profile.

---

*Awaiting your confirmation to proceed to Phase 1.*
