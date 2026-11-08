"""Stream keys: one active key per creator, shown with the RTMP URL to paste into OBS > Settings > Stream."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.live_common import require_creator
from app.config import get_settings
from app.db import get_db
from app.models import StreamKey, User, new_key_value
from app.security import get_current_user

router = APIRouter(prefix="/api/stream-keys", tags=["live"])


def _out(k: StreamKey) -> dict:
    return {"id": k.id, "key": k.key_value, "rtmp_url": k.rtmp_url, "full_url": f"{k.rtmp_url.rstrip('/')}/{k.key_value}",
            "is_active": k.is_active, "last_used_at": k.last_used_at}


def active_key(db: Session, user: User) -> StreamKey:
    k = db.scalar(select(StreamKey).where(StreamKey.creator_id == user.id, StreamKey.is_active.is_(True)).order_by(StreamKey.id.desc()))
    if k is None:
        k = StreamKey(creator_id=user.id, key_value=new_key_value(), rtmp_url=get_settings().rtmp_url, is_active=True)
        db.add(k)
        db.commit()
    return k


@router.get("/me")
def my_key(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    require_creator(user)
    return _out(active_key(db, user))


@router.post("/reset")
def reset_key(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """The old key stops working at once (an encoder still using it is refused on its next connect)."""
    require_creator(user)
    for k in db.scalars(select(StreamKey).where(StreamKey.creator_id == user.id, StreamKey.is_active.is_(True))):
        k.is_active = False
        k.last_used_at = k.last_used_at or datetime.now(UTC)
    db.commit()
    return _out(active_key(db, user))
