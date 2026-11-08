import enum
import secrets
import string
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.user import User

_ID = string.ascii_letters + string.digits + "-_"


def new_video_id() -> str:
    """11 random URL-safe characters, unguessable (like a YouTube video id)."""
    return "".join(secrets.choice(_ID) for _ in range(11))


class VideoPrivacy(str, enum.Enum):
    Public = "Public"
    Unlisted = "Unlisted"
    Private = "Private"
    Scheduled = "Scheduled"


class VideoStatus(str, enum.Enum):
    Uploading = "Uploading"
    Processing = "Processing"
    Ready = "Ready"
    Published = "Published"
    Failed = "Failed"
    Blocked = "Blocked"


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[str] = mapped_column(String(16), primary_key=True, default=new_video_id)
    creator_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200), default="")
    description: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    category: Mapped[str | None] = mapped_column(String(60))
    privacy: Mapped[VideoPrivacy] = mapped_column(Enum(VideoPrivacy, name="video_privacy"), default=VideoPrivacy.Private)
    status: Mapped[VideoStatus] = mapped_column(Enum(VideoStatus, name="video_status"), default=VideoStatus.Uploading, index=True)
    original_file_key: Mapped[str | None] = mapped_column(Text)
    duration: Mapped[float | None] = mapped_column(Float)
    file_size: Mapped[int | None] = mapped_column(BigInteger)
    view_count: Mapped[int] = mapped_column(Integer, default=0)
    publish_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    storage_provider: Mapped[str] = mapped_column(Text, default="hetzner")
    hetzner_region: Mapped[str] = mapped_column(Text, default="fsn1")
    gpu_job_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Beyond the base table.
    sha256: Mapped[str | None] = mapped_column(String(64), index=True)
    # "Publish" pressed while processing: goes public when 360p is ready.
    publish_when_ready: Mapped[bool] = mapped_column(default=False)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    gpu_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(10), default="upload")  # upload · live
    live_stream_id: Mapped[int | None] = mapped_column(ForeignKey("live_streams.id", ondelete="SET NULL"))
    error: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    # Cold archive (Storage Box) once the original leaves Object Storage after 7 days.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archive_path: Mapped[str | None] = mapped_column(Text)

    creator: Mapped[User] = relationship(lazy="joined")
