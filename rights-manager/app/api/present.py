"""Turns database rows into API responses."""

from datetime import UTC, datetime

from app.models import Dispute, Match, ReferenceVideo, Upload
from app.schemas import DisputeOut, MatchOut, ReferenceOut, UploadOut


def media_url(key: str | None) -> str | None:
    return f"/media/{key}" if key else None


def reference_out(r: ReferenceVideo) -> ReferenceOut:
    return ReferenceOut(
        id=r.id, title=r.title, policy=r.policy, status=r.status, error=r.error, duration=r.duration,
        file_hash_sha256=r.file_hash_sha256, thumbnail_url=media_url(r.thumbnail_path),
        frames=len(r.video_phash_list or []), has_audio=bool(r.audio_fingerprint), owner=r.owner.username, created_at=r.created_at,
    )


def upload_out(u: Upload, match: Match | None = None, dispute: Dispute | None = None) -> UploadOut:
    return UploadOut(
        id=u.id, title=u.title, status=u.status, message=u.message, duration=u.duration, thumbnail_url=media_url(u.thumbnail_path),
        audio_removed=u.audio_removed, has_watermark=u.has_watermark, watermark_text=u.watermark_text, uploader=u.uploader.username,
        created_at=u.created_at, match_id=match.id if match else None,
        can_dispute=bool(match and match.status in ("blocked", "muted") and dispute is None),
        dispute_id=dispute.id if dispute else None,
    )


def match_out(m: Match, dispute_id: int | None = None) -> MatchOut:
    return MatchOut(
        id=m.id, upload_id=m.upload_id, reference_id=m.reference_id, reference_title=m.reference.title,
        reference_owner=m.reference.owner.username, reference_thumbnail_url=media_url(m.reference.thumbnail_path),
        upload_title=m.upload.title, uploader=m.upload.uploader.username, upload_thumbnail_url=media_url(m.upload.thumbnail_path),
        upload_status=m.upload.status, video_score=m.video_score, audio_score=m.audio_score, combined_score=m.combined_score,
        exact=m.exact, has_watermark=m.has_watermark, status=m.status, policy=m.reference.policy, created_at=m.created_at,
        dispute_id=dispute_id,
    )


def dispute_out(d: Dispute) -> DisputeOut:
    m = d.match
    respond_by = d.respond_by if d.respond_by.tzinfo else d.respond_by.replace(tzinfo=UTC)
    return DisputeOut(
        id=d.id, match_id=m.id, upload_id=m.upload_id, upload_title=m.upload.title, upload_thumbnail_url=media_url(m.upload.thumbnail_path),
        reference_title=m.reference.title, reference_owner=m.reference.owner.username, uploader=d.uploader.username,
        reason=d.reason, status=d.status, creator_response=d.creator_response, creator_action=d.creator_action,
        admin_note=d.admin_note, respond_by=respond_by,
        overdue=d.creator_action is None and respond_by < datetime.now(UTC),
        created_at=d.created_at, decided_at=d.decided_at, combined_score=m.combined_score,
    )
