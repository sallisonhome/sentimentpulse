import os
from typing import Optional

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

# Resolve .env paths relative to this file's location so the correct file is
# found regardless of the process working directory (e.g. uvicorn --reload
# may run from a different cwd than the project root).
_this_dir = os.path.dirname(os.path.abspath(__file__))       # backend/
_project_root = os.path.dirname(_this_dir)                    # project root

# Load .env with override=True so non-empty .env values always win over blank
# system environment variables (e.g. ANTHROPIC_API_KEY='' set by Claude Code).
for _env_path in (
    os.path.join(_project_root, ".env"),   # <project>/.env  (primary)
    os.path.join(_this_dir, ".env"),       # <project>/backend/.env (fallback)
):
    if os.path.exists(_env_path):
        load_dotenv(_env_path, override=True)
        break


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(
            os.path.join(_project_root, ".env"),
            os.path.join(_this_dir, ".env"),
        ),
        env_file_encoding="utf-8",
        extra="ignore",
        # Treat empty system env vars as unset so .env file values win.
        # This prevents Claude Code's shell env (ANTHROPIC_API_KEY='') from
        # shadowing the real key in .env.
        env_ignore_empty=True,
    )

    # Database — defaults to SQLite in the backend working directory
    database_url: str = "sqlite:///./sentimentpulse.db"

    # Reddit
    reddit_client_id: str = ""
    reddit_client_secret: str = ""
    reddit_user_agent: str = "SentimentPulse/1.0"

    # Anthropic (used as fallback when Perplexity Sonar is unavailable)
    anthropic_api_key: str = ""

    # Perplexity Sonar — primary LLM for exec / recs / bold-ideas blocks.
    # When unset, the pipeline falls back to Anthropic Claude.
    perplexity_api_key: str = ""

    # Optional: pre-seed publisher name on first launch
    publisher_name: Optional[str] = None

    # Optional: also search Steam by developer name (catches games where Saber
    # is the developer but a third-party publisher like Focus Home is listed)
    developer_name: Optional[str] = None

    # Lightweight mode: skip heavy transformer/BERTopic models, use VADER + LDA only.
    # Recommended for servers with < 4 GB RAM.
    lightweight_nlp: bool = False

    # URL to the raw GitHub Gist containing Reddit data (fetched by GitHub Action).
    # Format: https://gist.githubusercontent.com/<user>/<gist_id>/raw/reddit_data.json
    reddit_gist_url: str = ""

    # Daily ingestion schedule (local server time). Default: 02:00.
    ingest_hour: int = 2
    ingest_minute: int = 0

    # v2 relevance gate (2026-07-24): Layer 2 fuzzy fallback kill-switch.
    # When True (default), is_post_relevant_to_game() attempts a proportional
    # Levenshtein fuzzy match against multi-word distinctive_keywords when
    # Layer 1's exact-substring match finds nothing. Set to False to disable
    # Layer 2 entirely (e.g. if a week of LAYER2_FUZZY_HIT audit logs shows
    # it's net-noisy) without touching any keyword lists.
    relevance_fuzzy_layer_enabled: bool = True


settings = Settings()
