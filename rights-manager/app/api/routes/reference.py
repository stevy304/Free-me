"""Originals a creator protects. Upload returns at once; fingerprinting runs in the worker."""

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.files import enqueue, save_video
from app.api.present import reference_out
from app.db import get_db
from app.models import Policy, ReferenceVideo, Role, User
from app.schemas import PolicyIn, ReferenceOut
from app.security import get_current_user
from app.storage import get_storage
from app.workers.tasks import process_reference

router = APIRouter(prefix="/api/references", tags=["references"])


def _own(db: Session, reference_id: int, user: User) -> ReferenceVideo:
    ref = db.get(ReferenceVideo, reference_id)
    if ref is None or (ref.owner_id != user.id and user.role != Role.admin):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Reference video not found.")
    return ref


@router.post("", response_model=ReferenceOut, status_code=status.HTTP_201_CREATED)
def create(
    file: UploadFile = File(...),
    title: str = Form(..., min_length=1, max_length=200),
    policy: Policy = Form(Policy.Block),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ReferenceOut:
    key = save_video(file, "references")
    ref = ReferenceVideo(owner_id=user.id, title=title.strip(), file_path=key, policy=policy, status="processing")
    db.add(ref)
    db.commit()

    def failed() -> None:
        ref.status, ref.error = "failed", "Processing could not start. Upload the video again."
        db.commit()

    enqueue(process_reference, ref.id, failed)
    db.refresh(ref)
    return reference_out(ref)


@router.get("", response_model=list[ReferenceOut])
def list_mine(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[ReferenceOut]:
    q = select(ReferenceVideo).order_by(ReferenceVideo.created_at.desc())
    if user.role != Role.admin:
        q = q.where(ReferenceVideo.owner_id == user.id)
    return [reference_out(r) for r in db.scalars(q)]


@router.get("/{reference_id}", response_model=ReferenceOut)
def get_one(reference_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> ReferenceOut:
    return reference_out(_own(db, reference_id, user))


@router.patch("/{reference_id}", response_model=ReferenceOut)
def set_policy(reference_id: int, body: PolicyIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> ReferenceOut:
    """Applies to uploads checked from now on."""
    ref = _own(db, reference_id, user)
    ref.policy = body.policy
    db.commit()
    return reference_out(ref)


@router.delete("/{reference_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete(reference_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> None:
    ref = _own(db, reference_id, user)
    storage = get_storage()
    for key in (ref.file_path, ref.thumbnail_path):
        if key:
            storage.delete(key)
    db.delete(ref)
    db.commit()
