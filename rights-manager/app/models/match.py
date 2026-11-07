from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.reference_video import ReferenceVideo
from app.models.upload import Upload


class Match(Base):
    """An upload compared with one original: the scores and what was decided."""

    __tablename__ = "matches"

    id: Mapped[int] = mapped_column(primary_key=True)
    upload_id: Mapped[int] = mapped_column(ForeignKey("uploads.id", ondelete="CASCADE"), index=True)
    reference_id: Mapped[int] = mapped_column(ForeignKey("reference_videos.id", ondelete="CASCADE"), index=True)
    video_score: Mapped[float] = mapped_column(Float)
    audio_score: Mapped[float | None] = mapped_column(Float)
    combined_score: Mapped[float] = mapped_column(Float)
    exact: Mapped[bool] = mapped_column(Boolean, default=False)
    has_watermark: Mapped[bool] = mapped_column(Boolean, default=False)
    # blocked · muted · flagged · tracked · approved (below the review line) · released (dispute won / admin cleared)
    status: Mapped[str] = mapped_column(String(20), index=True)
    policy_applied: Mapped[str | None] = mapped_column(String(10))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    upload: Mapped[Upload] = relationship(lazy="joined")
    reference: Mapped[ReferenceVideo] = relationship(lazy="joined")
