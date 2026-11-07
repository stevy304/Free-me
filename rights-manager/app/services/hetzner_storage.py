"""Hetzner Object Storage (S3-compatible). Every call to object storage in the platform goes through here.

Three buckets, named from HETZNER_BUCKET (e.g. videos-prod):
  <bucket>-originals  private   originals/{sha256}.{ext}            uploaded originals (content-addressed)
  <bucket>-stream     public    videos/{id}/hls/{q}/playlist.m3u8, videos/{id}/{q}.mp4, live VODs
  <bucket>-thumbs     public    thumbnails/{id}.jpg, thumbnails/{id}/*.webp, sprites
"""

import functools
import mimetypes
from pathlib import Path
from typing import Iterable, Literal

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from app.config import get_settings

Kind = Literal["originals", "stream", "thumbs"]

# Cache-Control by file type: segments never change, playlists always may, thumbnails for a day.
CACHE = {
    ".ts": "public, max-age=31536000, immutable",
    ".m4s": "public, max-age=31536000, immutable",
    ".mp4": "public, max-age=31536000, immutable",
    ".m4a": "public, max-age=31536000, immutable",
    ".m3u8": "public, max-age=0, must-revalidate",
    ".mpd": "public, max-age=0, must-revalidate",
    ".jpg": "public, max-age=86400",
    ".webp": "public, max-age=86400",
    ".vtt": "public, max-age=86400",
}
TYPES = {".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".m4s": "video/iso.segment", ".mpd": "application/dash+xml",
         ".webp": "image/webp", ".vtt": "text/vtt", ".m4a": "audio/mp4", ".mkv": "video/x-matroska", ".mov": "video/quicktime"}


def bucket(kind: Kind) -> str:
    return f"{get_settings().hetzner_bucket}-{kind}"


@functools.lru_cache
def get_client():
    s = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=s.hetzner_endpoint,
        aws_access_key_id=s.hetzner_access_key,
        aws_secret_access_key=s.hetzner_secret_key,
        region_name=s.hetzner_region,
        config=Config(signature_version="s3v4", s3={"addressing_style": s.hetzner_addressing},
                      retries={"max_attempts": 5, "mode": "standard"}, max_pool_connections=32),
    )


def content_type(key: str) -> str:
    ext = Path(key).suffix.lower()
    return TYPES.get(ext) or mimetypes.guess_type(key)[0] or "application/octet-stream"


def headers_for(key: str, public: bool) -> dict:
    extra = {"ContentType": content_type(key)}
    if public:
        extra["CacheControl"] = CACHE.get(Path(key).suffix.lower(), "public, max-age=3600")
        extra["ACL"] = "public-read"
    else:
        extra["CacheControl"] = "private, max-age=0"
    return extra


def upload_file(path: Path, kind: Kind, key: str, public: bool | None = None) -> int:
    """Uploads a local file (multipart in parallel for big files). Returns its size."""
    public = kind != "originals" if public is None else public
    get_client().upload_file(str(path), bucket(kind), key, ExtraArgs=headers_for(key, public))
    return path.stat().st_size


def upload_dir(folder: Path, kind: Kind, prefix: str, public: bool = True, skip: Iterable[str] = ()) -> int:
    """Uploads every file under `folder` to `prefix/…`; playlists last so they never point at missing segments."""
    files = sorted((p for p in folder.rglob("*") if p.is_file() and p.name not in skip), key=lambda p: p.suffix in (".m3u8", ".mpd"))
    total = 0
    for f in files:
        total += upload_file(f, kind, f"{prefix.rstrip('/')}/{f.relative_to(folder).as_posix()}", public)
    return total


def put_bytes(data: bytes, kind: Kind, key: str, public: bool | None = None) -> None:
    public = kind != "originals" if public is None else public
    get_client().put_object(Bucket=bucket(kind), Key=key, Body=data, **headers_for(key, public))


def get_bytes(kind: Kind, key: str) -> bytes:
    return get_client().get_object(Bucket=bucket(kind), Key=key)["Body"].read()


def download_file(kind: Kind, key: str, path: Path) -> None:
    get_client().download_file(bucket(kind), key, str(path))


def get_signed_url(kind: Kind, key: str, expires: int = 7200, filename: str | None = None) -> str:
    params = {"Bucket": bucket(kind), "Key": key}
    if filename:
        params["ResponseContentDisposition"] = f'attachment; filename="{filename}"'
    return get_client().generate_presigned_url("get_object", Params=params, ExpiresIn=expires)


def upload_chunk_presigned(kind: Kind, key: str, upload_id: str, part_number: int, expires: int = 3600) -> str:
    """A URL the browser PUTs one part to, straight into Hetzner (the API never sees the bytes)."""
    return get_client().generate_presigned_url(
        "upload_part", Params={"Bucket": bucket(kind), "Key": key, "UploadId": upload_id, "PartNumber": part_number}, ExpiresIn=expires
    )


def presigned_put(kind: Kind, key: str, content_type_: str, expires: int = 900) -> str:
    return get_client().generate_presigned_url("put_object", Params={"Bucket": bucket(kind), "Key": key, "ContentType": content_type_}, ExpiresIn=expires)


def create_multipart_upload(kind: Kind, key: str, content_type_: str) -> str:
    r = get_client().create_multipart_upload(Bucket=bucket(kind), Key=key, ContentType=content_type_, CacheControl="private, max-age=0")
    return r["UploadId"]


def upload_part(kind: Kind, key: str, upload_id: str, part_number: int, body) -> str:
    return get_client().upload_part(Bucket=bucket(kind), Key=key, UploadId=upload_id, PartNumber=part_number, Body=body)["ETag"]


def list_parts(kind: Kind, key: str, upload_id: str) -> list[dict]:
    """Parts Hetzner already holds: the truth for resuming (whatever the browser remembers)."""
    parts, marker = [], 0
    while True:
        r = get_client().list_parts(Bucket=bucket(kind), Key=key, UploadId=upload_id, PartNumberMarker=marker, MaxParts=1000)
        parts += [{"PartNumber": p["PartNumber"], "ETag": p["ETag"], "Size": p["Size"]} for p in r.get("Parts", [])]
        if not r.get("IsTruncated"):
            return parts
        marker = r["NextPartNumberMarker"]


def complete_multipart(kind: Kind, key: str, upload_id: str, parts: list[dict]) -> None:
    get_client().complete_multipart_upload(
        Bucket=bucket(kind), Key=key, UploadId=upload_id,
        MultipartUpload={"Parts": [{"PartNumber": p["PartNumber"], "ETag": p["ETag"]} for p in sorted(parts, key=lambda p: p["PartNumber"])]},
    )


def abort_multipart(kind: Kind, key: str, upload_id: str) -> None:
    try:
        get_client().abort_multipart_upload(Bucket=bucket(kind), Key=key, UploadId=upload_id)
    except ClientError:
        pass


def check_exists(kind: Kind, key: str) -> dict | None:
    """The object's size and metadata, or None."""
    try:
        r = get_client().head_object(Bucket=bucket(kind), Key=key)
        return {"size": r["ContentLength"], "etag": r.get("ETag"), "metadata": r.get("Metadata", {})}
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
            return None
        raise


def copy(kind: Kind, src: str, dst: str, public: bool | None = None, dst_kind: Kind | None = None) -> None:
    dst_kind = dst_kind or kind
    public = dst_kind != "originals" if public is None else public
    get_client().copy_object(Bucket=bucket(dst_kind), Key=dst, CopySource={"Bucket": bucket(kind), "Key": src},
                             MetadataDirective="REPLACE", **headers_for(dst, public))


def delete_file(kind: Kind, key: str) -> None:
    get_client().delete_object(Bucket=bucket(kind), Key=key)


def delete_prefix(kind: Kind, prefix: str) -> int:
    c, n = get_client(), 0
    for page in c.get_paginator("list_objects_v2").paginate(Bucket=bucket(kind), Prefix=prefix):
        keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
        if keys:
            c.delete_objects(Bucket=bucket(kind), Delete={"Objects": keys, "Quiet": True})
            n += len(keys)
    return n


def set_public(kind: Kind, prefix: str, public: bool) -> int:
    """Private and unlisted videos' files are private objects; publishing flips their ACL."""
    c, n = get_client(), 0
    for page in c.get_paginator("list_objects_v2").paginate(Bucket=bucket(kind), Prefix=prefix):
        for o in page.get("Contents", []):
            c.put_object_acl(Bucket=bucket(kind), Key=o["Key"], ACL="public-read" if public else "private")
            n += 1
    return n


def usage_bytes(kind: Kind) -> tuple[int, int]:
    """(bytes, objects) stored in one bucket."""
    c, size, count = get_client(), 0, 0
    for page in c.get_paginator("list_objects_v2").paginate(Bucket=bucket(kind)):
        for o in page.get("Contents", []):
            size += o["Size"]
            count += 1
    return size, count
