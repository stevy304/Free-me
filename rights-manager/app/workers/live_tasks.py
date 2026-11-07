"""Work for live streams that runs outside the request: the live Rights Manager check and saving the VOD."""

import logging
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.models import LiveStream, ReferenceVideo, Video, VideoPrivacy, VideoStatus
from app.services import actions, matcher, storage_manager
from app.services.video_processor import probe, sha256_file

log = logging.getLogger(__name__)
CLIP_SEGMENTS = 8  # ~16 s of program


def check_live_clip(stream_id: int, hls_dir: str, creator_id: int) -> dict | None:
    """Compares the last ~16 s of the live program with every protected original (not the creator's own).
    A combined score >= 85 flags the stream for administrators; a live stream is never blocked automatically."""
    from app.workers.tasks import fingerprint_video

    segs = sorted(Path(hls_dir).glob("*.ts"), key=lambda p: p.stat().st_mtime)[-CLIP_SEGMENTS:-1]
    if len(segs) < 3:
        return None
    work = Path(tempfile.mkdtemp(prefix="liveclip-"))
    try:
        clip = work / "clip.ts"
        with clip.open("wb") as out:
            for s in segs:
                out.write(s.read_bytes())
        fp = fingerprint_video(clip, audio_variants=True)
        mine = {"hashes": fp["hashes"], "audio": fp["audio"]}
        best: tuple[float, ReferenceVideo | None, matcher.Scores | None] = (0.0, None, None)
        with SessionLocal() as db:
            for ref in actions.references_to_check(db, creator_id):
                sc = matcher.compare(mine, {"hashes": ref.video_phash_list, "audio": ref.audio_fingerprint})
                if sc.combined > best[0]:
                    best = (sc.combined, ref, sc)
            result = {"checked_at": datetime.now(UTC).isoformat(), "score": best[0], "flagged": False,
                      "reference": best[1].title if best[1] else None, "owner": best[1].owner.username if best[1] else None,
                      "video_score": best[2].video if best[2] else None, "audio_score": best[2].audio if best[2] else None}
            if best[1] is not None and best[0] >= get_settings().block_at:
                stream = db.get(LiveStream, stream_id)
                result["flagged"] = True
                if stream and stream.rights_flagged_at is None:
                    stream.rights_score, stream.rights_reference_id = best[0], best[1].id
                    stream.rights_flagged_at = datetime.now(UTC)
                    actions.notify_admins(db, f"Live stream \"{stream.title}\" by @{stream.creator.username} matches \"{best[1].title}\" "
                                              f"({best[0]:.0f}%). You can mute its audio from the admin live view.", f"/live-studio?id={stream_id}")
                    db.commit()
        return result
    finally:
        shutil.rmtree(work, ignore_errors=True)
        try:
            (Path(hls_dir) / "clip.ts").unlink(missing_ok=True)
        except OSError:
            pass


def save_vod(stream_id: int, work_dir: str) -> str | None:
    """Joins the recording, stores it on Hetzner as an original and processes it like any upload."""
    from app.services import mixer
    from app.workers.transcode_tasks import enqueue_processing

    work = Path(work_dir)
    hz = storage_manager.backend()
    try:
        with storage_manager.temp_dir("vod-") as tmp:
            mp4 = tmp / "vod.mp4"
            if not mixer.concat_recordings(work, mp4):
                log.info("stream %s left no recording", stream_id)
                return None
            info = probe(mp4)
            sha = sha256_file(mp4)
            key = storage_manager.original_key(sha, ".mp4")
            if not hz.check_exists("originals", key):
                hz.upload_file(mp4, "originals", key, public=False)
            with SessionLocal() as db:
                stream = db.get(LiveStream, stream_id)
                if stream is None:
                    return None
                privacy = {"Public": VideoPrivacy.Public, "Unlisted": VideoPrivacy.Unlisted}.get(stream.privacy.value, VideoPrivacy.Private)
                v = Video(creator_id=stream.creator_id, title=stream.title, description=stream.description, category=stream.category,
                          privacy=privacy, status=VideoStatus.Processing, original_file_key=key, sha256=sha, duration=info.duration,
                          file_size=mp4.stat().st_size, width=info.width, height=info.height, source="live", live_stream_id=stream.id,
                          hetzner_region=get_settings().hetzner_region, publish_when_ready=privacy != VideoPrivacy.Private)
                db.add(v)
                db.flush()
                stream.vod_video_id = v.id
                db.commit()
                video_id = v.id
        enqueue_processing(video_id)
        return video_id
    finally:
        shutil.rmtree(work, ignore_errors=True)
