"""Hooks called by the RTMP server (rtmp/server.js) for every publish. Protected by RTMP_HOOK_SECRET."""

import hmac

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel

from app.config import get_settings
from app.services.rtmp_server import SUPERVISOR

router = APIRouter(prefix="/api/rtmp", tags=["rtmp hooks"])


class PublishIn(BaseModel):
    session_id: str | None = None
    stream_path: str
    ip: str | None = None
    local: bool = False


def _check(secret: str | None) -> None:
    if not hmac.compare_digest(secret or "", get_settings().rtmp_hook_secret):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "bad hook secret")


@router.post("/on_publish")
async def on_publish(body: PublishIn, x_rtmp_secret: str | None = Header(None)) -> dict:
    _check(x_rtmp_secret)
    return await SUPERVISOR.on_publish(body.stream_path, body.local)


@router.post("/on_done")
async def on_done(body: PublishIn, x_rtmp_secret: str | None = Header(None)) -> dict:
    _check(x_rtmp_secret)
    await SUPERVISOR.on_done(body.stream_path)
    return {"ok": True}
