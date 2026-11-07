import logging
from pathlib import Path

from fastapi import HTTPException, UploadFile, status

from app.config import get_settings
from app.storage import TooLarge, get_storage


def save_video(file: UploadFile, folder: str) -> str:
    """Checks type and size (MP4, MOV or WebM, MAX_UPLOAD_MB) and saves the file. Returns its storage key."""
    s = get_settings()
    ext = Path(file.filename or "").suffix.lower()
    if ext not in s.allowed_extensions:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Only MP4, MOV and WebM videos can be uploaded.")
    if file.size is not None and file.size > s.max_upload_mb * 1024 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f"Videos can be at most {s.max_upload_mb} MB.")
    try:
        key = get_storage().save_stream(file.file, folder, ext, s.max_upload_mb * 1024 * 1024)
    except TooLarge:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f"Videos can be at most {s.max_upload_mb} MB.") from None
    if get_storage().local_path(key).stat().st_size == 0:
        get_storage().delete(key)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The file is empty.")
    return key


def enqueue(task, row_id: int, on_fail) -> None:
    """Queues background work. If the queue (Redis) is down, the row is marked failed so the page does not wait
    forever, and the person is told to try again."""
    try:
        task.delay(row_id)
    except Exception as e:
        logging.getLogger(__name__).error("could not queue %s(%s): %s", task.name, row_id, e)
        on_fail()
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The checking service is not available right now. Try again in a minute.") from None
