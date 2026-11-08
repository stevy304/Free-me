"""Videos: the creator's list, one video, and editing details while it uploads or processes (saved as a draft)."""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Role, User, Video, VideoPrivacy, VideoStatus
from app.security import get_current_user

router = APIRouter(prefix="/api/videos", tags=["videos"])


def own_video(db: Session, video_id: str, user: User) -> Video:
    v = db.get(Video, video_id)
    if v is None or (v.creator_id != user.id and user.role != Role.admin):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Video not found.")
    return v


def video_out(v: Video) -> dict:
    return {
        "id": v.id, "title": v.title, "description": v.description, "tags": v.tags or [], "category": v.category, "privacy": v.privacy.value,
        "status": v.status.value, "duration": v.duration, "file_size": v.file_size, "view_count": v.view_count, "publish_at": v.publish_at,
        "published_at": v.published_at, "publish_when_ready": v.publish_when_ready, "width": v.width, "height": v.height, "source": v.source,
        "creator": v.creator.username, "creator_id": v.creator_id, "created_at": v.created_at, "error": v.error,
        "gpu_cost_usd": round(v.gpu_cost_usd or 0, 4), "storage_provider": v.storage_provider, "hetzner_region": v.hetzner_region,
    }


class VideoPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = Field(None, max_length=5000)
    tags: list[str] | None = Field(None, max_length=30)
    category: str | None = Field(None, max_length=60)


@router.get("/mine")
def mine(q: str | None = Query(None, max_length=100), status_: VideoStatus | None = Query(None, alias="status"),
         user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[dict]:
    stmt = select(Video).where(Video.creator_id == user.id).order_by(Video.created_at.desc()).limit(500)
    if q:
        stmt = stmt.where(or_(Video.title.ilike(f"%{q}%"), Video.description.ilike(f"%{q}%")))
    if status_:
        stmt = stmt.where(Video.status == status_)
    return [video_out(v) for v in db.scalars(stmt)]


@router.patch("/{video_id}")
def update(video_id: str, body: VideoPatch, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Details can be filled in while the file is still uploading or processing."""
    v = own_video(db, video_id, user)
    if body.title is not None:
        v.title = body.title.strip()
    if body.description is not None:
        v.description = body.description
    if body.tags is not None:
        v.tags = sorted({t.strip()[:40] for t in body.tags if t.strip()})
    if body.category is not None:
        v.category = body.category
    db.commit()
    return video_out(v)
