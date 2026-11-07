"""The platform's single entry point to storage. Only Hetzner Object Storage is allowed (STORAGE_BACKEND=hetzner);
local disk is temporary working space under HETZNER_TMP_DIR and is emptied after every job."""

import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path

from app.config import get_settings
from app.services import hetzner_storage as hz


class StorageConfigError(RuntimeError):
    pass


def backend():
    s = get_settings()
    if s.storage_backend != "hetzner":
        raise StorageConfigError(f"STORAGE_BACKEND must be 'hetzner' (got {s.storage_backend!r}); no other storage is supported.")
    return hz


@contextmanager
def temp_dir(prefix: str):
    """A scratch folder on local NVMe that is always deleted, even when the job fails."""
    root = get_settings().hetzner_tmp_dir
    root.mkdir(parents=True, exist_ok=True)
    path = Path(tempfile.mkdtemp(prefix=prefix, dir=root))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


# Storage layout (see README):
def original_key(sha256: str, ext: str) -> str:
    """Content-addressed: the same file is stored once, whoever uploads it again."""
    return f"originals/{sha256}{ext}"


def pending_key(upload_id: str, ext: str) -> str:
    """Where a multipart upload is assembled before its hash is known."""
    return f"uploads/{upload_id}{ext}"


def hls_prefix(video_id: str, quality: str) -> str:
    return f"videos/{video_id}/hls/{quality}"


def master_key(video_id: str) -> str:
    return f"videos/{video_id}/hls/master.m3u8"


def mp4_key(video_id: str, quality: str) -> str:
    return f"videos/{video_id}/{quality}.mp4"


def thumb_key(video_id: str) -> str:
    return f"thumbnails/{video_id}.jpg"


def thumbs_prefix(video_id: str) -> str:
    return f"thumbnails/{video_id}"
