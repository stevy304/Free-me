import enum

from sqlalchemy import Boolean, Enum, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Platform(str, enum.Enum):
    YouTube = "YouTube"
    Facebook = "Facebook"
    Twitch = "Twitch"
    Custom_RTMP = "Custom_RTMP"


class DestinationStatus(str, enum.Enum):
    Connected = "Connected"
    Disconnected = "Disconnected"
    Error = "Error"


class Destination(Base):
    """Another service the live program is forwarded to (FFmpeg -c copy, one process each)."""

    __tablename__ = "destinations"

    id: Mapped[int] = mapped_column(primary_key=True)
    stream_id: Mapped[int] = mapped_column(ForeignKey("live_streams.id", ondelete="CASCADE"), index=True)
    platform: Mapped[Platform] = mapped_column(Enum(Platform, name="destination_platform"))
    rtmp_url: Mapped[str] = mapped_column(Text)
    stream_key: Mapped[str] = mapped_column(Text)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[DestinationStatus] = mapped_column(Enum(DestinationStatus, name="destination_status"), default=DestinationStatus.Disconnected)
    last_error: Mapped[str | None] = mapped_column(Text)
