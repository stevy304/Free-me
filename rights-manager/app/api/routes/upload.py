"""Fast upload: resumable, chunked, parallel, straight to Hetzner. The API never carries the video's bytes unless the
browser uses the TUS-style fallback (PATCH /chunk), and even then each part goes to Hetzner and is deleted locally."""

import re
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import UploadSession, UploadState, User, Video, VideoStatus
from app.security import get_current_user
from app.services import chunk_manager, storage_manager, upload_manager
from app.workers.upload_tasks import finalize_upload

router = APIRouter(prefix="/api/uploads", tags=["upload"])
SHA = re.compile(r"^[0-9a-fA-F]{64}$")


class CreateIn(BaseModel):
    file_name: str = Field(min_length=1, max_length=255)
    file_size: int = Field(gt=0)
    sha256: str | None = Field(None, pattern=r"^[0-9a-fA-F]{64}$")
    title: str | None = Field(None, max_length=200)


@router.get("/limits")
def limits(user: User = Depends(get_current_user)) -> dict:
    limit, tier = upload_manager.limit_for(user)
    return {"max_bytes": limit, "tier": tier, "extensions": list(upload_manager.EXTENSIONS), "min_chunk": chunk_manager.MIN_PART,
            "can_upload": user.role.value != "viewer"}


@router.post("/create", status_code=status.HTTP_201_CREATED)
def create(body: CreateIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    sess, video = upload_manager.create(db, user, body.file_name, body.file_size, body.sha256, body.title)
    return upload_manager.session_out(sess)


@router.get("")
def unfinished(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[dict]:
    """Uploads that can still be resumed (after a refresh or on another visit)."""
    q = select(UploadSession).where(UploadSession.creator_id == user.id,
                                    UploadSession.status.in_([UploadState.Created, UploadState.Uploading, UploadState.Paused]),
                                    UploadSession.expires_at > datetime.now(UTC)).order_by(UploadSession.created_at.desc())
    return [upload_manager.session_out(s) for s in db.scalars(q)]


@router.head("/{upload_id}")
def head(upload_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> Response:
    """TUS-style: Upload-Offset is how many bytes Hetzner holds, so a client knows where to continue."""
    s = upload_manager.own_session(db, upload_id, user)
    live = _sync(s) if s.status != UploadState.Completed else None
    out = upload_manager.session_out(s, live)
    return Response(status_code=200, headers={"Upload-Offset": str(out["bytes_uploaded"]), "Upload-Length": str(s.file_size),
                                             "X-Uploaded-Chunks": str(out["uploaded_chunks"]), "X-Total-Chunks": str(s.total_chunks),
                                             "X-Chunk-Size": str(s.chunk_size), "Tus-Resumable": "1.0.0", "Cache-Control": "no-store"})


@router.get("/{upload_id}")
def get_session(upload_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    s = upload_manager.own_session(db, upload_id, user)
    return upload_manager.session_out(s)


def _sync(s: UploadSession) -> dict:
    hz = storage_manager.backend()
    parts = hz.list_parts("originals", s.object_key, s.s3_upload_id) if s.s3_upload_id else []
    return chunk_manager.sync_from_storage(s.upload_id_tus, parts) | {"numbers": sorted(p["PartNumber"] for p in parts)}


@router.get("/{upload_id}/parts")
def parts(upload_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Which parts Hetzner already has: resume uploads only the missing ones."""
    s = upload_manager.own_session(db, upload_id, user)
    if s.status == UploadState.Completed:
        return {"done": list(range(1, s.total_chunks + 1)), **upload_manager.session_out(s)}
    live = _sync(s)
    return {"done": live["numbers"], **upload_manager.session_out(s, live)}


class SignIn(BaseModel):
    part_numbers: list[int] = Field(min_length=1, max_length=100)


@router.post("/{upload_id}/sign")
def sign(upload_id: str, body: SignIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Presigned PUT URLs (valid 1 hour) for parts the browser sends straight to Hetzner."""
    s = upload_manager.own_session(db, upload_id, user)
    if s.status in (UploadState.Completed, UploadState.Failed):
        raise HTTPException(status.HTTP_409_CONFLICT, f"This upload is {s.status.value.lower()}.")
    hz = storage_manager.backend()
    urls = {}
    for n in body.part_numbers:
        if not 1 <= n <= s.total_chunks:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Part {n} is outside 1..{s.total_chunks}.")
        urls[str(n)] = hz.upload_chunk_presigned("originals", s.object_key, s.s3_upload_id, n, expires=3600)
    if s.status in (UploadState.Created, UploadState.Paused):
        s.status = UploadState.Uploading
        db.commit()
    return {"urls": urls, "expires_in": 3600}


class PartDoneIn(BaseModel):
    part_number: int = Field(ge=1)
    etag: str = Field(min_length=1, max_length=100)
    size: int = Field(gt=0)


@router.post("/{upload_id}/progress")
def part_done(upload_id: str, body: PartDoneIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """The browser reports each part it finished; progress lives in Redis (no database write per part)."""
    s = upload_manager.own_session(db, upload_id, user)
    if body.part_number > s.total_chunks or body.size != chunk_manager.expected_size(body.part_number, s.chunk_size, s.file_size):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "That part has the wrong number or size.")
    live = chunk_manager.record_part(s.upload_id_tus, body.part_number, body.size, body.etag)
    return {"uploaded_chunks": live["parts"], "bytes_uploaded": live["bytes"], "progress": round(live["bytes"] / s.file_size * 100, 2)}


class HashIn(BaseModel):
    sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")


@router.post("/{upload_id}/hash")
def file_hash(upload_id: str, body: HashIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """SHA-256 from the browser. The same file uploaded before is linked at once ("Already uploaded")."""
    s = upload_manager.own_session(db, upload_id, user)
    dup = upload_manager.link_duplicate(db, s, body.sha256)
    db.refresh(s)
    return {**upload_manager.session_out(s), "duplicate": bool(dup), "duplicate_title": dup.title if dup else None}


@router.post("/{upload_id}/pause")
def pause(upload_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    s = upload_manager.own_session(db, upload_id, user)
    if s.status in (UploadState.Created, UploadState.Uploading):
        s.status = UploadState.Paused
        db.commit()
    return upload_manager.session_out(s)


@router.post("/{upload_id}/complete", status_code=status.HTTP_202_ACCEPTED)
def complete(upload_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """All parts are on Hetzner: a worker joins them and starts processing. The page shows "Processing…" at once."""
    s = upload_manager.own_session(db, upload_id, user)
    if s.status == UploadState.Completed:
        return upload_manager.session_out(s)
    live = _sync(s)
    missing = sorted(set(range(1, s.total_chunks + 1)) - set(live["numbers"]))
    if missing:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{len(missing)} part(s) are still missing (first: {missing[0]}).")
    video = db.get(Video, s.video_id)
    video.status = VideoStatus.Processing
    s.status = UploadState.Uploading
    db.commit()
    finalize_upload.delay(s.upload_id_tus)
    db.refresh(s)
    return upload_manager.session_out(s) | {"status": "Completing"}


@router.delete("/{upload_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel(upload_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> None:
    """Cancel: the parts already on Hetzner are deleted and the draft video removed."""
    s = upload_manager.own_session(db, upload_id, user)
    if s.status == UploadState.Completed:
        raise HTTPException(status.HTTP_409_CONFLICT, "This upload is finished; delete the video instead.")
    if s.s3_upload_id:
        storage_manager.backend().abort_multipart("originals", s.object_key, s.s3_upload_id)
    chunk_manager.forget(s.upload_id_tus)
    video = db.get(Video, s.video_id)
    db.delete(s)
    if video:
        db.delete(video)
    db.commit()


# ---- TUS-style fallback through the API (when direct upload is blocked, e.g. by a corporate proxy) -----------------

RANGE = re.compile(r"bytes (\d+)-(\d+)/(\d+)")


@router.patch("/{upload_id}/chunk")
async def chunk(upload_id: str, request: Request, content_range: str = Header(...), user: User = Depends(get_current_user),
                db: Session = Depends(get_db)) -> Response:
    """One part through the API: `Content-Range: bytes start-end/total` (end inclusive). The part goes to a temporary
    file under HETZNER_TMP_DIR/chunks/<upload>/, then to Hetzner, then the temporary file is deleted."""
    s = upload_manager.own_session(db, upload_id, user)
    m = RANGE.fullmatch(content_range.strip())
    if not m:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Content-Range must look like: bytes 0-5242879/104857600")
    start, end, total = map(int, m.groups())
    if total != s.file_size or start % s.chunk_size != 0:
        raise HTTPException(status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE, f"Parts start at multiples of {s.chunk_size} bytes.")
    number = start // s.chunk_size + 1
    if end - start + 1 != chunk_manager.expected_size(number, s.chunk_size, s.file_size):
        raise HTTPException(status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE, "Each part must be a whole chunk.")
    hz = storage_manager.backend()
    root = storage_manager.get_settings().hetzner_tmp_dir / "chunks" / s.upload_id_tus
    root.mkdir(parents=True, exist_ok=True)
    tmp = root / f"{number:05d}.part"
    written = 0
    try:
        with tmp.open("wb") as f:
            async for piece in request.stream():
                written += len(piece)
                if written > end - start + 1:
                    raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "The body is larger than the range.")
                f.write(piece)
        if written != end - start + 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Expected {end - start + 1} bytes, got {written}.")
        with tmp.open("rb") as f:
            etag = hz.upload_part("originals", s.object_key, s.s3_upload_id, number, f)
    finally:
        tmp.unlink(missing_ok=True)
        try:
            root.rmdir()
        except OSError:
            pass
    live = chunk_manager.record_part(s.upload_id_tus, number, written, etag)
    if s.status != UploadState.Uploading:
        s.status = UploadState.Uploading
        db.commit()
    return Response(status_code=204, headers={"Upload-Offset": str(live["bytes"]), "X-Uploaded-Chunks": str(live["parts"]), "ETag": etag})
