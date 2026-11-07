import enum
from datetime import datetime

from sqlalchemy import JSON, DateTime, Enum, Float, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.user import User


class Policy(str, enum.Enum):
    """What happens to an upload that matches this original."""

    Block = "Block"  # it cannot be posted
    Mute = "Mute"  # it is posted without its sound
    Flag = "Flag"  # an administrator reviews it
    Track = "Track"  # it is posted; the owner sees the match


class ReferenceVideo(Base):
    __tablename__ = "reference_videos"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    file_path: Mapped[str] = mapped_column(String(500))
    file_hash_sha256: Mapped[str | None] = mapped_column(String(64), index=True)
    video_phash_list: Mapped[list | None] = mapped_column(JSON)
    audio_fingerprint: Mapped[str | None] = mapped_column(Text)
    duration: Mapped[float | None] = mapped_column(Float)
    thumbnail_path: Mapped[str | None] = mapped_column(String(500))
    policy: Mapped[Policy] = mapped_column(Enum(Policy, name="reference_policy"), default=Policy.Block)
    # Fingerprinting runs in the background: processing → ready (or failed, with the reason).
    status: Mapped[str] = mapped_column(String(20), default="processing")
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    owner: Mapped[User] = relationship(lazy="joined")
