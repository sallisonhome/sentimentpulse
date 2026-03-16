from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=("../.env", ".env"),   # root-level .env, fallback to local
        env_file_encoding="utf-8",
        extra="ignore",
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
