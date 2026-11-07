import enum
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Quality(str, enum.Enum):
    q2160 = "2160p"
    q1080 = "1080p"
    q720 = "720p"
    q480 = "480p"
    q360 = "360p"
    q144 = "144p"
    Audio_Only = "Audio_Only"


class VariantStatus(str, enum.Enum):
    Queued = "Queued"
    Processing = "Processing"
    Ready = "Ready"
    Failed = "Failed"


class VideoVariant(Base):
    __tablename__ = "video_variants"
    __table_args__ = (UniqueConstraint("video_id", "quality"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[str] = mapped_column(ForeignKey("videos.id", ondelete="CASCADE"), index=True)
    quality: Mapped[Quality] = mapped_column(Enum(Quality, name="variant_quality", values_callable=lambda e: [m.value for m in e]))
    codec: Mapped[str | None] = mapped_column(Text)
    file_key: Mapped[str | None] = mapped_column(Text)
    file_size: Mapped[int | None] = mapped_column(BigInteger)
    bitrate: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[VariantStatus] = mapped_column(Enum(VariantStatus, name="variant_status"), default=VariantStatus.Queued)

    # Beyond the base table: the job doing it, progress, cost, errors and retries.
    hls_key: Mapped[str | None] = mapped_column(Text)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    job_id: Mapped[str | None] = mapped_column(Text)
    runner: Mapped[str | None] = mapped_column(String(10))  # gpu · cpu
    gpu_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
