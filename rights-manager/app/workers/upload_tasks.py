"""Finishing an upload: join the parts on Hetzner, check the result, store it content-addressed, start processing."""

import logging
from datetime import UTC, datetime

from sqlalchemy import select

from app.db import SessionLocal
from app.models import UploadSession, UploadState, Video, VideoStatus
from app.services import chunk_manager, storage_manager
from app.services.video_processor import VideoError, probe
from app.workers.celery_app import celery

log = logging.getLogger(__name__)


@celery.task(name="finalize_upload", bind=True, max_retries=3)
def finalize_upload(self, upload_id: str) -> str:
    hz = storage_manager.backend()
    with SessionLocal() as db:
        s = db.scalar(select(UploadSession).where(UploadSession.upload_id_tus == upload_id))
        if s is None or s.status == UploadState.Completed:
            return "skipped"
        video = db.get(Video, s.video_id)
        try:
            parts = hz.list_parts("originals", s.object_key, s.s3_upload_id)
            if len(parts) != s.total_chunks or sum(p["Size"] for p in parts) != s.file_size:
                raise ValueError(f"expected {s.total_chunks} parts / {s.file_size} bytes, Hetzner has {len(parts)} / {sum(p['Size'] for p in parts)}")
            # Hetzner joins the parts itself: nothing passes through this server.
            hz.complete_multipart("originals", s.object_key, s.s3_upload_id, parts)
            head = hz.check_exists("originals", s.object_key)
            if not head or head["size"] != s.file_size:
                raise ValueError("the joined file has the wrong size")
            # FFmpeg reads the header over a signed URL (a few hundred KB), so a corrupt file fails here, not on the GPU.
            try:
                info = probe(hz.get_signed_url("originals", s.object_key, 600))  # type: ignore[arg-type]
            except VideoError as e:
                hz.delete_file("originals", s.object_key)
                s.status, s.error = UploadState.Failed, f"This file is not a readable video: {e}"[:500]
                video.status, video.error = VideoStatus.Failed, s.error
                db.commit()
                return "corrupt"
            key = s.object_key
            if s.sha256:
                # Content-addressed: the key is the file's SHA-256 (the GPU worker checks it while reading).
                key = storage_manager.original_key(s.sha256, "." + s.object_key.rsplit(".", 1)[-1])
                if not hz.check_exists("originals", key):
                    hz.copy("originals", s.object_key, key, public=False)
                hz.delete_file("originals", s.object_key)
            video.original_file_key, video.sha256 = key, s.sha256
            video.duration, video.width, video.height, video.file_size = info.duration, info.width, info.height, s.file_size
            video.status = VideoStatus.Processing
            s.status, s.completed_at, s.uploaded_chunks, s.bytes_uploaded = UploadState.Completed, datetime.now(UTC), s.total_chunks, s.file_size
            s.s3_upload_id = None
            db.commit()
        except Exception as e:
            log.exception("finalizing %s failed", upload_id)
            db.rollback()
            if self.request.retries < self.max_retries and not celery.conf.task_always_eager:
                raise self.retry(exc=e, countdown=5 * 2 ** self.request.retries) from e
            s = db.scalar(select(UploadSession).where(UploadSession.upload_id_tus == upload_id))
            s.status, s.error = UploadState.Failed, f"The upload could not be finished: {e}"[:500]
            db.get(Video, s.video_id).status = VideoStatus.Failed
            db.commit()
            return "failed"
        video_id = video.id
    chunk_manager.forget(upload_id)
    from app.workers.transcode_tasks import enqueue_processing

    enqueue_processing(video_id)
    return "completed"
