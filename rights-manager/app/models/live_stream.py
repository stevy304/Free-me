import enum
import secrets
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Enum, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.user import User


class LivePrivacy(str, enum.Enum):
    Public = "Public"
    Unlisted = "Unlisted"
    Private = "Private"


class LiveStatus(str, enum.Enum):
    Scheduled = "Scheduled"
    Live = "Live"
    Ended = "Ended"


class LiveStream(Base):
    __tablename__ = "live_streams"

    id: Mapped[int] = mapped_column(primary_key=True)
    creator_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    category: Mapped[str | None] = mapped_column(String(60))
    description: Mapped[str | None] = mapped_column(Text)
    thumbnail_url: Mapped[str | None] = mapped_column(Text)
    privacy: Mapped[LivePrivacy] = mapped_column(Enum(LivePrivacy, name="live_privacy"), default=LivePrivacy.Public)
    status: Mapped[LiveStatus] = mapped_column(Enum(LiveStatus, name="live_status"), default=LiveStatus.Scheduled, index=True)
    stream_key_id: Mapped[int | None] = mapped_column(ForeignKey("stream_keys.id", ondelete="SET NULL"), index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    viewer_peak: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Beyond the base table: scheduling, control-room state, chat moderation, Rights Manager and the saved VOD.
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # "Waiting for OBS" after the creator presses GO LIVE, until the encoder connects.
    armed: Mapped[bool] = mapped_column(Boolean, default=False)
    # Scenes, sources, mixer levels, overlays: what the control room shows and the FFmpeg mixer renders.
    studio_state: Mapped[dict] = mapped_column(JSON, default=dict)
    likes: Mapped[int] = mapped_column(Integer, default=0)
    slow_mode_seconds: Mapped[int] = mapped_column(Integer, default=0)
    blocked_words: Mapped[list] = mapped_column(JSON, default=list)
    auto_moderate: Mapped[bool] = mapped_column(Boolean, default=True)
    # Set when the live picture/sound matches a protected original (combined score >= 85).
    rights_score: Mapped[float | None] = mapped_column(Float)
    rights_reference_id: Mapped[int | None] = mapped_column(ForeignKey("reference_videos.id", ondelete="SET NULL"))
    rights_flagged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    audio_muted_by_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    vod_video_id: Mapped[str | None] = mapped_column(String(16))
    # Public id in the HLS URL (/hls/<playback_id>/index.m3u8); the stream key itself is never shown to viewers.
    playback_id: Mapped[str] = mapped_column(String(24), unique=True, default=lambda: secrets.token_urlsafe(12))

    creator: Mapped[User] = relationship(lazy="joined")


class ChatMessage(Base):
    __tablename__ = "live_chat_messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    stream_id: Mapped[int] = mapped_column(ForeignKey("live_streams.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    username: Mapped[str] = mapped_column(String(40))
    text: Mapped[str] = mapped_column(String(500))
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    # chat · superchat (amount in cents) · system
    kind: Mapped[str] = mapped_column(String(12), default="chat")
    amount_cents: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ChatBan(Base):
    """A timeout (until a time) or a ban (no end) from one stream's chat."""

    __tablename__ = "live_chat_bans"

    id: Mapped[int] = mapped_column(primary_key=True)
    stream_id: Mapped[int] = mapped_column(ForeignKey("live_streams.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
