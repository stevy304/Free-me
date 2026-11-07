"""Disputes: the uploader contests a claim, the original's owner answers within 7 days, an administrator decides."""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.present import dispute_out
from app.db import get_db
from app.models import Dispute, DisputeLog, DisputeStatus, Match, Notification, ReferenceVideo, Role, User
from app.schemas import DecideIn, DisputeIn, DisputeOut, LogOut, NotificationOut, RespondIn
from app.security import get_current_user, require_admin
from app.services import actions

router = APIRouter(prefix="/api/disputes", tags=["disputes"])
notifications = APIRouter(prefix="/api/notifications", tags=["notifications"])


def _visible(db: Session, dispute_id: int, user: User) -> Dispute:
    d = db.get(Dispute, dispute_id)
    if d is None or not (user.role == Role.admin or d.uploader_id == user.id or d.match.reference.owner_id == user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dispute not found.")
    return d


@router.post("", response_model=DisputeOut, status_code=status.HTTP_201_CREATED)
def open_dispute(body: DisputeIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> DisputeOut:
    m = db.get(Match, body.match_id)
    if m is None or m.upload.uploader_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Match not found.")
    if m.status not in ("blocked", "muted"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Only a blocked or muted video can be disputed.")
    if db.scalar(select(Dispute.id).where(Dispute.match_id == m.id)):
        raise HTTPException(status.HTTP_409_CONFLICT, "This claim is already disputed.")
    d = actions.open_dispute(db, m, user, body.reason.strip())
    db.commit()
    return dispute_out(d)


@router.get("", response_model=list[DisputeOut])
def list_disputes(
    status_: DisputeStatus | None = Query(None, alias="status"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[DisputeOut]:
    """Administrators see every dispute; others see the ones they opened and the ones against their originals."""
    stmt = select(Dispute).join(Dispute.match).join(Match.reference).order_by(Dispute.created_at.desc()).limit(500)
    if user.role != Role.admin:
        stmt = stmt.where(or_(Dispute.uploader_id == user.id, ReferenceVideo.owner_id == user.id))
    if status_:
        stmt = stmt.where(Dispute.status == status_)
    return [dispute_out(d) for d in db.scalars(stmt).unique()]


@router.get("/{dispute_id}", response_model=DisputeOut)
def get_one(dispute_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> DisputeOut:
    return dispute_out(_visible(db, dispute_id, user))


@router.post("/{dispute_id}/respond", response_model=DisputeOut)
def respond(dispute_id: int, body: RespondIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> DisputeOut:
    """The original's owner releases the claim (the upload goes up) or upholds it (an administrator decides)."""
    d = _visible(db, dispute_id, user)
    if d.match.reference.owner_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the owner of the original can respond.")
    if d.status != DisputeStatus.Pending or d.creator_action is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This dispute has already been answered.")
    actions.creator_respond(db, d, user, body.action, body.response.strip())
    db.commit()
    return dispute_out(d)


@router.post("/{dispute_id}/decide", response_model=DisputeOut)
def decide(dispute_id: int, body: DecideIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> DisputeOut:
    d = _visible(db, dispute_id, admin)
    if d.status != DisputeStatus.Pending:
        raise HTTPException(status.HTTP_409_CONFLICT, "This dispute is already decided.")
    actions.admin_decide(db, d, admin, body.approve, body.admin_note.strip())
    db.commit()
    return dispute_out(d)


@router.get("/{dispute_id}/log", response_model=list[LogOut])
def history(dispute_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[LogOut]:
    d = _visible(db, dispute_id, user)
    rows = db.execute(
        select(DisputeLog, User.username).outerjoin(User, User.id == DisputeLog.actor_id).where(DisputeLog.dispute_id == d.id).order_by(DisputeLog.id)
    ).all()
    return [LogOut(id=row.id, action=row.action, note=row.note, actor=name, created_at=row.created_at) for row, name in rows]


@notifications.get("", response_model=list[NotificationOut])
def my_notifications(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[Notification]:
    return list(db.scalars(select(Notification).where(Notification.user_id == user.id).order_by(Notification.id.desc()).limit(50)))


@notifications.post("/read", status_code=status.HTTP_204_NO_CONTENT)
def mark_read(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> None:
    for n in db.scalars(select(Notification).where(Notification.user_id == user.id, Notification.read.is_(False))):
        n.read = True
    db.commit()
