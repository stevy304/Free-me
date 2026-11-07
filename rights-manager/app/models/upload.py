import enum
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Enum, Float, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.user import User


class UploadStatus(str, enum.Enum):
    Processing = "Processing"
    Approved = "Approved"
    Blocked = "Blocked"
    Flagged = "Flagged"
    Failed = "Failed"  # the file could not be read as a video


class Upload(Base):
    __tablename__ = "uploads"

    id: Mapped[int] = mapped_column(primary_key=True)
    uploader_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str | None] = mapped_column(String(200))
    file_path: Mapped[str] = mapped_column(String(500))
    file_hash_sha256: Mapped[str | None] = mapped_column(String(64), index=True)
    video_phash_list: Mapped[list | None] = mapped_column(JSON)
    audio_fingerprint: Mapped[str | None] = mapped_column(Text)
    duration: Mapped[float | None] = mapped_column(Float)
    thumbnail_path: Mapped[str | None] = mapped_column(String(500))
    status: Mapped[UploadStatus] = mapped_column(Enum(UploadStatus, name="upload_status"), default=UploadStatus.Processing, index=True)
    # What the uploader is told (blocked, muted…), and the copy without sound when the policy is Mute.
    message: Mapped[str | None] = mapped_column(Text)
    audio_removed: Mapped[bool] = mapped_column(Boolean, default=False)
    muted_path: Mapped[str | None] = mapped_column(String(500))
    has_watermark: Mapped[bool] = mapped_column(Boolean, default=False)
    watermark_text: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    uploader: Mapped[User] = relationship(lazy="joined")
