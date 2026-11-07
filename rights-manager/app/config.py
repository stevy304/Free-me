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

    # ---- Platform: storage (Hetzner Object Storage only; local disk is temporary space)
    storage_backend: str = "hetzner"
    hetzner_endpoint: str = "https://fsn1.your-objectstorage.com"
    hetzner_bucket: str = "videos-prod"  # buckets: <name>-originals, <name>-stream, <name>-thumbs
    hetzner_access_key: str = ""
    hetzner_secret_key: str = ""
    hetzner_region: str = "fsn1"
    hetzner_cdn_url: str = "https://cdn.myapp.com"
    hetzner_tmp_dir: Path = Path("/tmp/uploads")
    # "virtual" (bucket.fsn1.your-objectstorage.com, Hetzner's default) or "path".
    hetzner_addressing: str = "virtual"
    # Public base URLs of the two public buckets (Cloudflare in front). Both default to HETZNER_CDN_URL, with a
    # Cloudflare origin rule sending /thumbnails/* to the thumbs bucket and everything else to the stream bucket.
    cdn_stream_url: str = ""
    cdn_thumbs_url: str = ""
    cloudflare_zone_id: str = ""
    cloudflare_api_token: str = ""
    # ---- Platform: online GPU (RunPod Serverless)
    runpod_api_key: str = ""
    runpod_endpoint_id: str = ""
    runpod_api_base: str = "https://api.runpod.ai/v2"
    # What the endpoint's GPU costs per second (RTX 4090 flex workers are about $0.00031/s).
    runpod_price_per_sec: float = 0.00031
    gpu_callback_secret: str = "change-me-gpu-callback-secret"
    # ---- Platform: live
    rtmp_url: str = "rtmp://localhost:1935/live"  # what creators paste into OBS
    rtmp_internal_url: str = "rtmp://127.0.0.1:1935/live"  # what this server's FFmpeg reads and writes
    rtmp_hook_secret: str = "change-me-rtmp-hook-secret"
    rtmp_stats_url: str = "http://127.0.0.1:8001/stats"
    hls_url: str = "https://cdn.myapp.com/hls"
    hls_dir: Path = Path("/tmp/platform-hls")
    live_work_dir: Path = Path("/tmp/platform-live")
    # libx264 everywhere; h264_nvenc on a machine with an NVIDIA GPU.
    live_encoder: str = "libx264"
    live_width: int = 1280
    live_height: int = 720
    live_fps: int = 30
    live_bitrate_kbps: int = 4500
    live_reconnect_seconds: int = 30
    # Live Rights Manager check: every N seconds the last ~16 s of the program is compared with protected originals.
    live_rights_interval: int = 60
    live_low_bitrate_kbps: int = 2000
    # ---- Platform: URLs
    public_api_url: str = "http://localhost:8000"
    frontend_url: str = "http://localhost:3000"


@lru_cache
def get_settings() -> Settings:
    return Settings()
