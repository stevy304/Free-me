"""Where the live program is forwarded: YouTube, Facebook, Twitch or any RTMP server (one FFmpeg -c copy each)."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.live_common import own_stream
from app.db import get_db
from app.models import Destination, DestinationStatus, Platform, User
from app.security import get_current_user
from app.services.rtmp_server import SUPERVISOR

router = APIRouter(tags=["live"])

# The ingest URL each platform gives; the creator pastes their key.
DEFAULT_URLS = {
    Platform.YouTube: "rtmp://a.rtmp.youtube.com/live2",
    Platform.Facebook: "rtmps://live-api-s.facebook.com:443/rtmp",
    Platform.Twitch: "rtmp://live.twitch.tv/app",
}


class DestinationIn(BaseModel):
    platform: Platform
    rtmp_url: str | None = Field(None, max_length=500)
    stream_key: str = Field("", max_length=500)
    is_enabled: bool = True


class DestinationPatch(BaseModel):
    rtmp_url: str | None = Field(None, max_length=500)
    stream_key: str | None = Field(None, max_length=500)
    is_enabled: bool | None = None


def _mask(key: str) -> str:
    return key[:4] + "•" * max(0, min(len(key) - 8, 12)) + key[-4:] if len(key) > 8 else "•" * len(key)


def _out(d: Destination) -> dict:
    sess = SUPERVISOR.sessions.get(d.stream_id)
    live = sess.restreams.get(d.id) if sess else None
    return {"id": d.id, "stream_id": d.stream_id, "platform": d.platform.value, "rtmp_url": d.rtmp_url, "stream_key_masked": _mask(d.stream_key),
            "is_enabled": d.is_enabled, "status": (live.status if live else d.status.value), "error": (live.error if live else d.last_error)}


def _valid_url(url: str) -> None:
    if not url.startswith(("rtmp://", "rtmps://")):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The server URL must start with rtmp:// or rtmps://.")


@router.get("/api/live/{stream_id}/destinations")
def list_destinations(stream_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[dict]:
    own_stream(db, stream_id, user)
    return [_out(d) for d in db.scalars(select(Destination).where(Destination.stream_id == stream_id).order_by(Destination.id))]


@router.post("/api/live/{stream_id}/destinations", status_code=status.HTTP_201_CREATED)
async def add_destination(stream_id: int, body: DestinationIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    own_stream(db, stream_id, user)
    url = (body.rtmp_url or DEFAULT_URLS.get(body.platform) or "").strip()
    if not url:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Enter the RTMP server URL.")
    _valid_url(url)
    if body.platform != Platform.Custom_RTMP and not body.stream_key.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Paste your {body.platform.value} stream key.")
    d = Destination(stream_id=stream_id, platform=body.platform, rtmp_url=url, stream_key=body.stream_key.strip(), is_enabled=body.is_enabled,
                    status=DestinationStatus.Disconnected)
    db.add(d)
    db.commit()
    sess = SUPERVISOR.sessions.get(stream_id)
    if sess and sess.program_live and d.is_enabled:
        asyncio.create_task(SUPERVISOR.start_restreams(sess))
    return _out(d)


@router.patch("/api/destinations/{dest_id}")
async def update_destination(dest_id: int, body: DestinationPatch, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    d = db.get(Destination, dest_id)
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Destination not found.")
    own_stream(db, d.stream_id, user)
    if body.rtmp_url is not None:
        _valid_url(body.rtmp_url.strip())
        d.rtmp_url = body.rtmp_url.strip()
    if body.stream_key is not None:
        d.stream_key = body.stream_key.strip()
    if body.is_enabled is not None:
        d.is_enabled = body.is_enabled
    db.commit()
    sess = SUPERVISOR.sessions.get(d.stream_id)
    if sess:
        # Turning one destination off (or changing it) never touches the others.
        await SUPERVISOR.stop_restreams(sess, dest_id=d.id)
        if d.is_enabled and sess.program_live:
            asyncio.create_task(SUPERVISOR.start_restreams(sess))
    db.refresh(d)
    return _out(d)


@router.delete("/api/destinations/{dest_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_destination(dest_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> None:
    d = db.get(Destination, dest_id)
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Destination not found.")
    own_stream(db, d.stream_id, user)
    sess = SUPERVISOR.sessions.get(d.stream_id)
    if sess:
        await SUPERVISOR.stop_restreams(sess, dest_id=d.id)
    db.delete(d)
    db.commit()
