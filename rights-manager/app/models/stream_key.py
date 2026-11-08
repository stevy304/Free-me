import secrets
import string
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

_ALPHABET = string.ascii_lowercase + string.digits


def new_key_value() -> str:
    """`live_xxxx_xxxx_xxxx_xxxx` — 16 random characters (about 82 bits), like a YouTube stream key."""
    parts = ["".join(secrets.choice(_ALPHABET) for _ in range(4)) for _ in range(4)]
    return "live_" + "_".join(parts)


class StreamKey(Base):
    __tablename__ = "stream_keys"

    id: Mapped[int] = mapped_column(primary_key=True)
    creator_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    key_value: Mapped[str] = mapped_column(Text, unique=True, index=True)
    rtmp_url: Mapped[str] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
