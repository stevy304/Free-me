"""Part arithmetic and live progress for uploads.

Browsers send parts straight to Hetzner (S3 multipart). Parts are at least 5 MB (S3's minimum) and grow for very large
files so no upload needs more than 10,000 parts (S3's maximum): a 100 GB file uses ~11 MB parts.
Progress is kept in Redis (cheap to update on every part); Hetzner's own list of parts is the truth when resuming.
"""

import math

from app.redis_client import get_redis

MIN_PART = 5 * 1024 * 1024
MAX_PARTS = 10_000
MB = 1024 * 1024


def part_size_for(file_size: int) -> int:
    need = math.ceil(file_size / (MAX_PARTS - 100))  # a little headroom
    return max(MIN_PART, math.ceil(need / MB) * MB)


def total_parts(file_size: int, part_size: int) -> int:
    return max(1, math.ceil(file_size / part_size))


def part_range(part_number: int, part_size: int, file_size: int) -> tuple[int, int]:
    """Byte range [start, end) of a part (numbers start at 1)."""
    start = (part_number - 1) * part_size
    return start, min(start + part_size, file_size)


def expected_size(part_number: int, part_size: int, file_size: int) -> int:
    s, e = part_range(part_number, part_size, file_size)
    return e - s


def _key(upload_id: str) -> str:
    return f"upload:{upload_id}:parts"


def record_part(upload_id: str, part_number: int, size: int, etag: str) -> dict:
    r = get_redis()
    pipe = r.pipeline()
    pipe.hset(_key(upload_id), str(part_number), f"{size}:{etag}")
    pipe.expire(_key(upload_id), 8 * 86400)
    pipe.execute()
    return progress(upload_id)


def progress(upload_id: str) -> dict:
    parts = get_redis().hgetall(_key(upload_id))
    return {"parts": len(parts), "bytes": sum(int(v.split(":", 1)[0]) for v in parts.values())}


def sync_from_storage(upload_id: str, parts: list[dict]) -> dict:
    """Replaces Redis' view with the parts Hetzner really holds (after a resume or a crash)."""
    r = get_redis()
    pipe = r.pipeline()
    pipe.delete(_key(upload_id))
    if parts:
        pipe.hset(_key(upload_id), mapping={str(p["PartNumber"]): f"{p['Size']}:{p['ETag']}" for p in parts})
        pipe.expire(_key(upload_id), 8 * 86400)
    pipe.execute()
    return progress(upload_id)


def forget(upload_id: str) -> None:
    get_redis().delete(_key(upload_id))
