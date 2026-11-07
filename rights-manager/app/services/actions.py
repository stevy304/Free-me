"""What happens after a check: each match gets a status from its score and the original's policy, the upload gets
the strictest outcome, people are told, and disputes move through their steps (each one logged)."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Dispute, DisputeLog, DisputeStatus, Match, Notification, Policy, ReferenceVideo, Role, Upload, UploadStatus, User

BLOCKED_MESSAGE = "This video cannot be posted, it matches original content by @{owner}"
MUTED_MESSAGE = "Audio removed due to copyright"
FLAGGED_MESSAGE = "This video is waiting for a review because it looks like original content by @{owner}."
WATERMARK_BONUS = 10.0
# Matches under the review line are still recorded from here, so owners see near misses.
RECORD_AT = 50.0

# How strict each match outcome is when several originals match one upload.
SEVERITY = {"blocked": 4, "flagged": 3, "muted": 2, "tracked": 1, "approved": 0}


def match_status(combined: float, policy: Policy) -> str:
    s = get_settings()
    if combined >= s.block_at:
        return {Policy.Block: "blocked", Policy.Mute: "muted", Policy.Flag: "flagged", Policy.Track: "tracked"}[policy]
    if combined >= s.flag_at:
        return "flagged"
    return "approved"


def with_watermark(combined: float, has_watermark: bool) -> float:
    """A TikTok/CapCut/YouTube mark means the video came from another platform: it counts against the upload."""
    return min(100.0, round(combined + WATERMARK_BONUS, 1)) if has_watermark and combined > 0 else combined


def notify(db: Session, user_id: int, text: str, link: str | None = None) -> None:
    db.add(Notification(user_id=user_id, text=text, link=link))


def notify_admins(db: Session, text: str, link: str | None = None) -> None:
    for admin_id in db.scalars(select(User.id).where(User.role == Role.admin)):
        notify(db, admin_id, text, link)


def apply_outcome(db: Session, upload: Upload, matches: list[Match]) -> str | None:
    """Sets the upload's status and message from its matches. Returns "mute" when its sound must be removed."""
    decisive = [m for m in matches if m.status != "approved"]
    worst = max(decisive, key=lambda m: (SEVERITY[m.status], m.combined_score), default=None)
    mute = any(m.status == "muted" for m in matches)
    if worst is None or worst.status == "tracked":
        upload.status, upload.message = UploadStatus.Approved, None
    elif worst.status == "blocked":
        upload.status, upload.message = UploadStatus.Blocked, BLOCKED_MESSAGE.format(owner=worst.reference.owner.username)
    elif worst.status == "flagged":
        upload.status, upload.message = UploadStatus.Flagged, FLAGGED_MESSAGE.format(owner=worst.reference.owner.username)
        notify_admins(db, f"An upload by @{upload.uploader.username} needs review ({worst.combined_score:.0f}% like \"{worst.reference.title}\").", "/matches?status=flagged")
    else:  # muted
        upload.status, upload.message = UploadStatus.Approved, MUTED_MESSAGE
    for m in decisive:
        verb = {"blocked": "was blocked", "muted": "was posted without sound", "flagged": "is waiting for review", "tracked": "was posted (tracked)"}[m.status]
        notify(db, m.reference.owner_id, f"An upload by @{upload.uploader.username} matched \"{m.reference.title}\" ({m.combined_score:.0f}%) and {verb}.", f"/matches?q={upload.uploader.username}")
    if upload.status == UploadStatus.Blocked:
        notify(db, upload.uploader_id, f"{upload.message}. You can dispute this if you have the rights to use it.", "/upload")
    return "mute" if mute and upload.status != UploadStatus.Blocked else None


def decisive_match(db: Session, upload_id: int) -> Match | None:
    """The match that decided an upload's outcome (the strictest, then highest score)."""
    ms = list(db.scalars(select(Match).where(Match.upload_id == upload_id)))
    return max(ms, key=lambda m: (SEVERITY.get(m.status, 0), m.combined_score), default=None)


# ---- review queue (admin) ---------------------------------------------------------------------------------------------

def review(db: Session, match: Match, admin: User, approve: bool, note: str | None) -> None:
    upload = match.upload
    others = [m for m in db.scalars(select(Match).where(Match.upload_id == upload.id, Match.id != match.id))]
    if approve:
        match.status = "released"
        if not any(m.status in ("blocked", "flagged") for m in others):
            upload.status = UploadStatus.Approved
            upload.message = MUTED_MESSAGE if upload.audio_removed else None
        notify(db, upload.uploader_id, f"Your upload \"{upload.title or upload.id}\" was approved after review.", "/upload")
    else:
        match.status = "blocked"
        upload.status = UploadStatus.Blocked
        upload.message = BLOCKED_MESSAGE.format(owner=match.reference.owner.username)
        notify(db, upload.uploader_id, f"{upload.message}. You can dispute this if you have the rights to use it.", "/upload")
    notify(db, match.reference.owner_id, f"An administrator {'approved' if approve else 'blocked'} @{upload.uploader.username}'s upload that matched \"{match.reference.title}\"." + (f" Note: {note}" if note else ""), "/matches")


# ---- disputes --------------------------------------------------------------------------------------------------------

def log(db: Session, dispute: Dispute, actor: User | None, action: str, note: str | None = None) -> None:
    db.add(DisputeLog(dispute_id=dispute.id, actor_id=actor.id if actor else None, action=action, note=note))


def open_dispute(db: Session, match: Match, uploader: User, reason: str) -> Dispute:
    d = Dispute(match_id=match.id, uploader_id=uploader.id, reason=reason, status=DisputeStatus.Pending,
                respond_by=datetime.now(UTC) + timedelta(days=get_settings().dispute_days))
    db.add(d)
    db.flush()
    log(db, d, uploader, "opened", reason)
    notify(db, match.reference.owner_id,
           f"@{uploader.username} disputed the claim on their upload that matched \"{match.reference.title}\". Respond within {get_settings().dispute_days} days.",
           f"/disputes?id={d.id}")
    return d


def release_upload(db: Session, match: Match) -> None:
    """The claim is dropped: the upload goes up (with its sound back if it was muted by this claim)."""
    match.status = "released"
    upload = match.upload
    others = [m for m in db.scalars(select(Match).where(Match.upload_id == upload.id, Match.id != match.id))]
    if any(m.status == "blocked" for m in others):
        return  # another original still blocks it
    upload.status = UploadStatus.Approved
    if upload.audio_removed and not any(m.status == "muted" for m in others):
        upload.audio_removed = False
    upload.message = MUTED_MESSAGE if upload.audio_removed else None


def creator_respond(db: Session, d: Dispute, creator: User, action: str, response: str) -> None:
    d.creator_action, d.creator_response = action, response
    log(db, d, creator, "creator_released" if action == "release" else "creator_upheld", response)
    if action == "release":
        d.status, d.decided_at = DisputeStatus.Approved, datetime.now(UTC)
        release_upload(db, d.match)
        notify(db, d.uploader_id, f"@{creator.username} released the claim. Your upload is now posted.", f"/disputes?id={d.id}")
    else:
        notify(db, d.uploader_id, f"@{creator.username} upheld the claim. An administrator will decide.", f"/disputes?id={d.id}")
        notify_admins(db, f"Dispute #{d.id} needs a decision: @{creator.username} upheld the claim against @{d.uploader.username}.", f"/disputes?id={d.id}")


def admin_decide(db: Session, d: Dispute, admin: User, approve: bool, note: str) -> None:
    d.status = DisputeStatus.Approved if approve else DisputeStatus.Rejected
    d.admin_note, d.decided_at = note, datetime.now(UTC)
    log(db, d, admin, "admin_approved" if approve else "admin_rejected", note)
    if approve:
        release_upload(db, d.match)
    text = "approved: your upload is now posted" if approve else "rejected: your upload stays blocked"
    notify(db, d.uploader_id, f"Your dispute was {text}. Note: {note}", f"/disputes?id={d.id}")
    notify(db, d.match.reference.owner_id, f"Dispute #{d.id} by @{d.uploader.username} was {'approved' if approve else 'rejected'} by an administrator.", f"/disputes?id={d.id}")


def references_to_check(db: Session, uploader_id: int) -> list[ReferenceVideo]:
    """Every protected original except the uploader's own."""
    return list(db.scalars(select(ReferenceVideo).where(ReferenceVideo.status == "ready", ReferenceVideo.owner_id != uploader_id)))
