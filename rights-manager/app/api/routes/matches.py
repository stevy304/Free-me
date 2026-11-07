"""Matches: a creator sees uploads that matched their originals; administrators see all and work the review queue."""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.present import match_out
from app.db import get_db
from app.models import Dispute, Match, ReferenceVideo, Role, Upload, UploadStatus, User
from app.schemas import MatchOut, ReviewIn
from app.security import get_current_user, require_admin
from app.services import actions

router = APIRouter(prefix="/api/matches", tags=["matches"])

STATUSES = ("blocked", "muted", "flagged", "tracked", "approved", "released")


def _with_disputes(db: Session, ms: list[Match]) -> list[MatchOut]:
    ids = [m.id for m in ms]
    disputes = dict(db.execute(select(Dispute.match_id, Dispute.id).where(Dispute.match_id.in_(ids))).all()) if ids else {}
    return [match_out(m, disputes.get(m.id)) for m in ms]


@router.get("", response_model=list[MatchOut])
def list_matches(
    status_: str | None = Query(None, alias="status", description="blocked, muted, flagged, tracked, approved or released"),
    q: str | None = Query(None, max_length=40, description="Uploader username contains"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MatchOut]:
    stmt = select(Match).join(Match.reference).join(Match.upload).join(Upload.uploader).order_by(Match.created_at.desc()).limit(500)
    if user.role != Role.admin:
        stmt = stmt.where(ReferenceVideo.owner_id == user.id)
    if status_:
        if status_ not in STATUSES:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Status must be one of: {', '.join(STATUSES)}.")
        stmt = stmt.where(Match.status == status_)
    if q and q.strip():
        stmt = stmt.where(func.lower(User.username).contains(q.strip().lower().lstrip("@")))
    return _with_disputes(db, list(db.scalars(stmt).unique()))


@router.get("/review", response_model=list[MatchOut])
def review_queue(_: User = Depends(require_admin), db: Session = Depends(get_db)) -> list[MatchOut]:
    """Flagged matches whose upload is still waiting."""
    stmt = select(Match).join(Match.upload).where(Match.status == "flagged", Upload.status == UploadStatus.Flagged).order_by(Match.created_at)
    return _with_disputes(db, list(db.scalars(stmt).unique()))


@router.post("/{match_id}/review", response_model=MatchOut)
def review(match_id: int, body: ReviewIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> MatchOut:
    m = db.get(Match, match_id)
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Match not found.")
    if m.status != "flagged":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only flagged matches wait for review.")
    actions.review(db, m, admin, body.action == "approve", body.note)
    db.commit()
    return _with_disputes(db, [m])[0]
