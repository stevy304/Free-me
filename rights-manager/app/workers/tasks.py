"""Background work: fingerprinting originals and checking uploads. The API only saves the file and queues one of these."""

import logging
import shutil
from pathlib import Path

from app.db import SessionLocal
from app.models import Match, Policy, ReferenceVideo, Upload, UploadStatus
from app.services import actions, audio_processor, fingerprint, matcher, video_processor, watermark
from app.storage import get_storage
from app.workers.celery_app import celery

log = logging.getLogger(__name__)


def fingerprint_video(path: Path, *, audio_variants: bool) -> dict:
    """Everything the matcher needs from one file: SHA-256, length, thumbnail, frame hashes and sound fingerprint."""
    info = video_processor.probe(path)
    sha = video_processor.sha256_file(path)
    thumb = video_processor.make_thumbnail(path, info.duration)
    folder, frames = video_processor.extract_frames(path)
    try:
        hashes = fingerprint.hash_frames(frames)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    audio = audio_processor.audio_fingerprint(path, with_variants=audio_variants) if info.has_audio else None
    return {"info": info, "sha": sha, "thumb": thumb, "hashes": hashes, "audio": audio}


@celery.task(name="process_reference", bind=True, max_retries=2)
def process_reference(self, reference_id: int) -> str:
    storage = get_storage()
    with SessionLocal() as db:
        ref = db.get(ReferenceVideo, reference_id)
        if ref is None:
            return "gone"
        try:
            fp = fingerprint_video(storage.local_path(ref.file_path), audio_variants=False)
        except video_processor.VideoError as e:
            ref.status, ref.error = "failed", f"This file could not be read as a video: {e}"[:500]
            db.commit()
            return "failed"
        except Exception as e:  # a crash mid-way (disk, ffmpeg killed): try again, then give up with the reason
            log.exception("reference %s failed", reference_id)
            if self.request.retries < self.max_retries and not celery.conf.task_always_eager:
                raise self.retry(exc=e, countdown=10) from e
            ref.status, ref.error = "failed", "Processing failed. Upload the video again."
            db.commit()
            return "failed"

        # The same file registered by someone else first: the first owner keeps it.
        other = db.query(ReferenceVideo).filter(
            ReferenceVideo.file_hash_sha256 == fp["sha"], ReferenceVideo.id != ref.id, ReferenceVideo.owner_id != ref.owner_id,
            ReferenceVideo.status == "ready",
        ).first()
        ref.file_hash_sha256 = fp["sha"]
        ref.duration = fp["info"].duration
        ref.thumbnail_path = storage.put_file(fp["thumb"], "thumbnails", ".jpg")
        if other is not None:
            ref.status, ref.error = "failed", f"This exact video is already registered by @{other.owner.username}."
            db.commit()
            return "duplicate"
        ref.video_phash_list = fp["hashes"]
        ref.audio_fingerprint = fp["audio"]
        ref.status, ref.error = "ready", None
        db.commit()
        return "ready"


@celery.task(name="process_upload", bind=True, max_retries=2)
def process_upload(self, upload_id: int) -> str:
    """Checks an upload against every protected original and applies the outcome."""
    storage = get_storage()
    with SessionLocal() as db:
        upload = db.get(Upload, upload_id)
        if upload is None or upload.status != UploadStatus.Processing:
            return "skipped"
        path = storage.local_path(upload.file_path)
        try:
            info = video_processor.probe(path)
            upload.duration = info.duration
            upload.file_hash_sha256 = video_processor.sha256_file(path)
            upload.thumbnail_path = storage.put_file(video_processor.make_thumbnail(path, info.duration), "thumbnails", ".jpg")
            refs = actions.references_to_check(db, upload.uploader_id)

            # Phase 3, step 1: the very same file. A Block policy decides at once, without fingerprinting.
            exact = [r for r in refs if r.file_hash_sha256 == upload.file_hash_sha256]
            scored: list[tuple[ReferenceVideo, matcher.Scores]] = [(r, matcher.Scores(100.0, 100.0 if r.audio_fingerprint else None, 100.0, exact=True)) for r in exact]
            if not any(r.policy == Policy.Block for r in exact):
                folder, frames = video_processor.extract_frames(path)
                try:
                    upload.video_phash_list = fingerprint.hash_frames(frames)
                finally:
                    shutil.rmtree(folder, ignore_errors=True)
                upload.audio_fingerprint = audio_processor.audio_fingerprint(path, with_variants=True) if info.has_audio else None
                mark = watermark.detect(path, info.duration)
                upload.has_watermark, upload.watermark_text = mark is not None, mark
                mine = {"hashes": upload.video_phash_list, "audio": upload.audio_fingerprint}
                for r in refs:
                    if r in exact:
                        continue
                    scored.append((r, matcher.compare(mine, {"hashes": r.video_phash_list, "audio": r.audio_fingerprint})))
        except video_processor.VideoError as e:
            upload.status, upload.message = UploadStatus.Failed, f"This file could not be read as a video: {e}"[:500]
            db.commit()
            return "failed"
        except Exception as e:
            log.exception("upload %s failed", upload_id)
            db.rollback()
            if self.request.retries < self.max_retries and not celery.conf.task_always_eager:
                raise self.retry(exc=e, countdown=10) from e
            upload = db.get(Upload, upload_id)
            upload.status, upload.message = UploadStatus.Failed, "The check failed. Upload the video again."
            db.commit()
            return "failed"

        matches = []
        for ref, sc in scored:
            combined = 100.0 if sc.exact else actions.with_watermark(sc.combined, upload.has_watermark)
            if combined < actions.RECORD_AT:
                continue
            m = Match(upload_id=upload.id, reference_id=ref.id, video_score=sc.video, audio_score=sc.audio, combined_score=combined,
                      exact=sc.exact, has_watermark=upload.has_watermark, status=actions.match_status(combined, ref.policy), policy_applied=ref.policy.value)
            m.reference = ref
            db.add(m)
            matches.append(m)
        db.flush()
        if actions.apply_outcome(db, upload, matches) == "mute":
            upload.muted_path = storage.put_file(video_processor.strip_audio(path), "checks/muted", path.suffix)
            upload.audio_removed = True
        db.commit()
        return upload.status.value
