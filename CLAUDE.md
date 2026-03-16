# SentimentPulse — Project Context for Claude Code

## What This Project Is
A full-stack game publisher sentiment tracking application. It scrapes Steam Reviews, Steam Forums, and Reddit daily, classifies community posts by sentiment (positive/negative/neutral), extracts recurring topics, and presents findings on a React dashboard with KPI visualizations, executive summaries, and AI-generated recommended actions.

## Tech Stack
- **Frontend**: React 18 + TypeScript + Vite + TailwindCSS + shadcn/ui + Recharts + TanStack Query
- **Backend**: Python FastAPI + Uvicorn + SQLAlchemy
- **Database**: SQLite (dev) / PostgreSQL (prod) via DATABASE_URL env var
- **NLP**: HuggingFace Transformers (cardiffnlp/twitter-roberta-base-sentiment-latest) + VADER fallback
- **Topic Modeling**: BERTopic / LDA (scikit-learn)
- **Scheduler**: APScheduler (daily 2:00 AM ingestion)
- **Reddit**: PRAW library
- **AI Summaries**: Anthropic Claude API (claude-3-5-haiku-latest)

## Key Architecture Decisions
- All external IDs (Steam review IDs, Reddit post IDs) are stored with a composite unique constraint (external_id + source) to prevent duplicate ingestion
- The ingestion pipeline is in `backend/ingestor.py` — it is the single source of truth for data collection
- All API keys live in `.env` — never hard-code credentials
- The default selected game in the UI is always the most recently released game by the publisher

## Database Tables
publishers → games → raw_posts → sentiment_records
games → daily_summaries (one per game per day)
games → topic_trends (rolling topic lifetime records)

## Frontend Routes
/ → Dashboard (KPI overview, default: most recent game)
/summary → Executive Summary + Recommended Actions
/topics → Topic Trends browser
/posts → Raw Posts browser
/settings → Publisher config + game management

## Current Build Phase
Phase 12 complete — all phases done

## API Base URL
Frontend calls backend at http://localhost:8000/api in dev (Vite proxy configured)

## DO NOT
- Do not add features beyond what is specified unless asked
- Do not change the database schema without running a new Alembic migration
- Do not remove existing tests
- Do not hard-code publisher names or game IDs — all must come from the database
