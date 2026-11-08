"""Resumable uploads of up to 100 GB, straight from the browser into Hetzner Object Storage.

1. create   – checks type and the account's limit, makes the video (draft) and an S3 multipart upload
2. parts    – presigned URLs: the browser PUTs each part directly to Hetzner (4 in parallel, adaptive)
3. progress – the browser reports each finished part (Redis); /parts asks Hetzner which parts exist (resume)
4. hash     – SHA-256 computed in the browser while uploading; a file the creator already uploaded is linked at once
5. complete – a worker joins the parts (CompleteMultipartUpload, no copying through this server), checks the size
              and that FFmpeg can read it, stores it content-addressed and starts processing
"""

import secrets
from datetime import UTC, datetime, timedelta
from pathlib import PurePosixPath

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Plan, Role, UploadSession, UploadState, User, Video, VideoPrivacy, VideoStatus
from app.services import chunk_manager, storage_manager

GB = 1024 ** 3
LIMITS = {"free": 2 * GB, "paid": 10 * GB, "verified": 100 * GB}
EXTENSIONS = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska"}
SESSION_DAYS = 7


def limit_for(user: User) -> tuple[int, str]:
    """Free 2 GB, paid 10 GB, verified creators (and administrators) 100 GB."""
    if user.role == Role.admin or user.verified:
        return LIMITS["verified"], "verified"
    if user.plan == Plan.paid:
        return LIMITS["paid"], "paid"
    return LIMITS["free"], "free"


def check_file(user: User, file_name: str, file_size: int) -> str:
    if user.role == Role.viewer:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Viewer accounts cannot upload. Switch to a creator account.")
    ext = PurePosixPath(file_name).suffix.lower()
    if ext not in EXTENSIONS:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Only MP4, MOV, WebM and MKV videos can be uploaded.")
    if file_size <= 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The file is empty.")
    limit, tier = limit_for(user)
    if file_size > limit:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            f"Your {tier} account can upload videos up to {limit // GB} GB. This file is {file_size / GB:.1f} GB.")
    return ext


def own_session(db: Session, upload_id: str, user: User) -> UploadSession:
    s = db.scalar(select(UploadSession).where(UploadSession.upload_id_tus == upload_id))
    if s is None or (s.creator_id != user.id and user.role != Role.admin):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Upload not found.")
    if s.status in (UploadState.Created, UploadState.Uploading, UploadState.Paused) and s.expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_410_GONE, "This upload expired. Start it again.")
    return s


def create(db: Session, user: User, file_name: str, file_size: int, sha256: str | None, title: str | None) -> tuple[UploadSession, Video]:
    ext = check_file(user, file_name, file_size)
    hz = storage_manager.backend()
    part = chunk_manager.part_size_for(file_size)
    upload_id = "up_" + secrets.token_urlsafe(18)
    video = Video(creator_id=user.id, title=(title or PurePosixPath(file_name).stem)[:200], privacy=VideoPrivacy.Private,
                  status=VideoStatus.Uploading, file_size=file_size, tags=[])
    db.add(video)
    db.flush()
    key = storage_manager.pending_key(upload_id, ext)
    s3_id = hz.create_multipart_upload("originals", key, EXTENSIONS[ext])
    sess = UploadSession(creator_id=user.id, file_name=file_name[:255], file_size=file_size, total_chunks=chunk_manager.total_parts(file_size, part),
                         uploaded_chunks=0, chunk_size=part, upload_id_tus=upload_id, status=UploadState.Created,
                         expires_at=datetime.now(UTC) + timedelta(days=SESSION_DAYS), video_id=video.id, object_key=key, s3_upload_id=s3_id,
                         content_type=EXTENSIONS[ext])
    db.add(sess)
    db.commit()
    if sha256:
        link_duplicate(db, sess, sha256)
    return sess, video


def find_duplicate(db: Session, creator_id: int, sha256: str, exclude: str) -> Video | None:
    """Only the creator's own files are matched (a hash must never give access to someone else's video)."""
    return db.scalar(select(Video).where(Video.creator_id == creator_id, Video.sha256 == sha256, Video.id != exclude,
                                         Video.original_file_key.is_not(None), Video.status != VideoStatus.Failed).order_by(Video.created_at))


def link_duplicate(db: Session, sess: UploadSession, sha256: str) -> Video | None:
    """The same file is already on Hetzner: stop uploading, point this video at the stored original."""
    sess.sha256 = sha256.lower()
    db.commit()
    dup = find_duplicate(db, sess.creator_id, sess.sha256, sess.video_id)
    if dup is None or sess.status == UploadState.Completed:
        return None
    hz = storage_manager.backend()
    if not hz.check_exists("originals", dup.original_file_key):
        return None
    if sess.s3_upload_id:
        hz.abort_multipart("originals", sess.object_key, sess.s3_upload_id)
    chunk_manager.forget(sess.upload_id_tus)
    video = db.get(Video, sess.video_id)
    video.original_file_key, video.sha256 = dup.original_file_key, dup.sha256
    video.duration, video.width, video.height = dup.duration, dup.width, dup.height
    video.status = VideoStatus.Processing
    sess.status, sess.duplicate_of, sess.completed_at = UploadState.Completed, dup.id, datetime.now(UTC)
    sess.uploaded_chunks, sess.bytes_uploaded = sess.total_chunks, sess.file_size
    db.commit()
    from app.workers.transcode_tasks import enqueue_processing

    enqueue_processing(video.id)
    return dup


def session_out(s: UploadSession, live: dict | None = None) -> dict:
    live = live or chunk_manager.progress(s.upload_id_tus)
    done = s.status == UploadState.Completed
    return {
        "upload_id": s.upload_id_tus, "video_id": s.video_id, "file_name": s.file_name, "file_size": s.file_size,
        "chunk_size": s.chunk_size, "total_chunks": s.total_chunks,
        "uploaded_chunks": s.total_chunks if done else live["parts"], "bytes_uploaded": s.file_size if done else live["bytes"],
        "status": s.status.value, "expires_at": s.expires_at, "duplicate_of": s.duplicate_of, "error": s.error,
    }
