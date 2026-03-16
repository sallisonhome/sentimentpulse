import os
from typing import Optional

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

# Load .env files with override=True so non-empty .env values always win over
# blank system environment variables (e.g. ANTHROPIC_API_KEY='' set by the
# Claude Code CLI shell).
for _env_path in ("../.env", ".env"):
    if os.path.exists(_env_path):
        load_dotenv(_env_path, override=True)
        break


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=("../.env", ".env"),   # root-level .env, fallback to local
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

    # Anthropic
    anthropic_api_key: str = ""

    # Optional: pre-seed publisher name on first launch
    publisher_name: Optional[str] = None

    # Optional: also search Steam by developer name (catches games where Saber
    # is the developer but a third-party publisher like Focus Home is listed)
    developer_name: Optional[str] = None


settings = Settings()
