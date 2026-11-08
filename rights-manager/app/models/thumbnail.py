from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Thumbnail(Base):
    __tablename__ = "thumbnails"

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[str] = mapped_column(ForeignKey("videos.id", ondelete="CASCADE"), index=True)
    file_key: Mapped[str] = mapped_column(Text)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    is_custom: Mapped[bool] = mapped_column(Boolean, default=False)
    timestamp: Mapped[float | None] = mapped_column(Float)
    # thumb (a still) · sprite (seek-bar preview sheet) · vtt (its index)
    kind: Mapped[str] = mapped_column(String(10), default="thumb")
    selected: Mapped[bool] = mapped_column(Boolean, default=False)
