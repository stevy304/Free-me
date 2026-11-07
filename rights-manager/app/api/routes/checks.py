"""Rights Manager checks: a video is checked against protected originals before posting (GET /api/checks/{id} is polled)."""

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.files import enqueue, save_video
from app.api.present import upload_out
from app.db import get_db
from app.models import Dispute, Role, Upload, UploadStatus, User
from app.schemas import UploadOut
from app.security import get_current_user
from app.services.actions import decisive_match
from app.workers.tasks import process_upload

router = APIRouter(prefix="/api/checks", tags=["rights checks"])


def _out(db: Session, u: Upload) -> UploadOut:
    m = decisive_match(db, u.id) if u.status != UploadStatus.Processing else None
    d = db.scalar(select(Dispute).where(Dispute.match_id == m.id)) if m else None
    return upload_out(u, m, d)


@router.post("", response_model=UploadOut, status_code=status.HTTP_202_ACCEPTED)
def create(
    file: UploadFile = File(...),
    title: str | None = Form(None, max_length=200),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UploadOut:
    key = save_video(file, "checks")
    upload = Upload(uploader_id=user.id, title=(title or file.filename or "").strip()[:200] or None, file_path=key, status=UploadStatus.Processing)
    db.add(upload)
    db.commit()

    def failed() -> None:
        upload.status, upload.message = UploadStatus.Failed, "The check could not start. Upload the video again."
        db.commit()

    enqueue(process_upload, upload.id, failed)
    db.refresh(upload)
    return _out(db, upload)


@router.get("", response_model=list[UploadOut])
def list_mine(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[UploadOut]:
    q = select(Upload).where(Upload.uploader_id == user.id).order_by(Upload.created_at.desc()).limit(200)
    return [_out(db, u) for u in db.scalars(q)]


@router.get("/{upload_id}", response_model=UploadOut)
def get_one(upload_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> UploadOut:
    u = db.get(Upload, upload_id)
    if u is None or (u.uploader_id != user.id and user.role != Role.admin):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Upload not found.")
    return _out(db, u)
