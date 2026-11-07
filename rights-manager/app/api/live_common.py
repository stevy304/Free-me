"""Shared helpers for the live routes: loading a stream with permissions, and its public shape."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import LivePrivacy, LiveStream, Role, User


def own_stream(db: Session, stream_id: int, user: User) -> LiveStream:
    s = db.get(LiveStream, stream_id)
    if s is None or (s.creator_id != user.id and user.role != Role.admin):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Live stream not found.")
    return s


def visible_stream(db: Session, stream_id: int, user: User | None) -> LiveStream:
    s = db.get(LiveStream, stream_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Live stream not found.")
    if s.privacy == LivePrivacy.Private and not (user and (user.id == s.creator_id or user.role == Role.admin)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Live stream not found.")
    return s


def require_creator(user: User) -> None:
    if user.role == Role.viewer:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only creators can do this.")


def hls_url(s: LiveStream) -> str:
    return f"{get_settings().hls_url.rstrip('/')}/{s.playback_id}/index.m3u8"


def stream_out(s: LiveStream, extra: dict | None = None) -> dict:
    return {
        "id": s.id, "title": s.title, "category": s.category, "description": s.description, "thumbnail_url": s.thumbnail_url,
        "privacy": s.privacy.value, "status": s.status.value, "armed": s.armed, "scheduled_for": s.scheduled_for,
        "started_at": s.started_at, "ended_at": s.ended_at, "viewer_peak": s.viewer_peak, "likes": s.likes,
        "creator": s.creator.username, "creator_id": s.creator_id, "hls_url": hls_url(s), "vod_video_id": s.vod_video_id,
        "created_at": s.created_at, **(extra or {}),
    }
