from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All settings come from the environment (or a .env file); see .env.example."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://rights:rights@127.0.0.1:5432/rights"
    redis_url: str = "redis://127.0.0.1:6379/0"
    jwt_secret: str = "change-me-in-production-please-32+chars"
    jwt_minutes: int = 60 * 24
    upload_dir: Path = Path("uploads")
    frame_dir: Path = Path("/tmp/frames")
    max_upload_mb: int = 500
    allowed_extensions: tuple[str, ...] = (".mp4", ".mov", ".webm")
    # One frame every N seconds is fingerprinted.
    frame_every_sec: float = 2.0
    # Score rules: combined >= block_at blocks, >= flag_at flags for review, below approves.
    block_at: float = 85.0
    flag_at: float = 70.0
    # Days a creator has to answer a dispute.
    dispute_days: int = 7
    # Run Celery tasks in-process (tests, a single machine without a worker).
    celery_eager: bool = False
    cors_origins: str = "http://localhost:3000"


@lru_cache
def get_settings() -> Settings:
    return Settings()
