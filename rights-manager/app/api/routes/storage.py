"""Storage tools: an upload speed test against Hetzner, and (for administrators) what the buckets hold."""

import secrets

from fastapi import APIRouter, Depends

from app.models import User
from app.security import get_current_user, require_admin
from app.services import storage_manager

router = APIRouter(prefix="/api/storage", tags=["storage"])
TEST_BYTES = 5 * 1024 * 1024


@router.post("/speedtest")
def speedtest(user: User = Depends(get_current_user)) -> dict:
    """A presigned PUT for a 5 MB test file straight to Hetzner: the browser times it to pick its parallelism.
    Test files are removed by the bucket's lifecycle rule (speedtest/ after 1 day) and by the cleanup job."""
    hz = storage_manager.backend()
    key = f"speedtest/{user.id}-{secrets.token_hex(6)}.bin"
    return {"url": hz.presigned_put("originals", key, "application/octet-stream", expires=300), "bytes": TEST_BYTES, "key": key}


@router.get("/usage")
def usage(_: User = Depends(require_admin)) -> dict:
    hz = storage_manager.backend()
    out = {}
    for kind in ("originals", "stream", "thumbs"):
        size, count = hz.usage_bytes(kind)
        out[kind] = {"bucket": hz.bucket(kind), "bytes": size, "objects": count}
    return out
