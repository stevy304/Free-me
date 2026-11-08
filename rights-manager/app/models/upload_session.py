import enum
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class UploadState(str, enum.Enum):
    Created = "Created"
    Uploading = "Uploading"
    Paused = "Paused"
    Completed = "Completed"
    Failed = "Failed"


class UploadSession(Base):
    """One resumable upload: an S3 multipart upload on Hetzner, written to directly by the browser."""

    __tablename__ = "upload_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    creator_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    file_name: Mapped[str] = mapped_column(String(255))
    file_size: Mapped[int] = mapped_column(BigInteger)
    total_chunks: Mapped[int] = mapped_column(Integer)
    uploaded_chunks: Mapped[int] = mapped_column(Integer, default=0)
    chunk_size: Mapped[int] = mapped_column(Integer)
    # Public id of the upload (used in /api/uploads/{id}); unique, unguessable.
    upload_id_tus: Mapped[str] = mapped_column(Text, unique=True, index=True)
    status: Mapped[UploadState] = mapped_column(Enum(UploadState, name="upload_state"), default=UploadState.Created)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Beyond the base table.
    video_id: Mapped[str] = mapped_column(ForeignKey("videos.id", ondelete="CASCADE"), index=True)
    object_key: Mapped[str] = mapped_column(Text)  # where the multipart upload is assembled
    s3_upload_id: Mapped[str | None] = mapped_column(Text)
    content_type: Mapped[str] = mapped_column(String(80), default="video/mp4")
    sha256: Mapped[str | None] = mapped_column(String(64))
    bytes_uploaded: Mapped[int] = mapped_column(BigInteger, default=0)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    duplicate_of: Mapped[str | None] = mapped_column(String(16))
    error: Mapped[str | None] = mapped_column(Text)
