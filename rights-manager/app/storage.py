"""Where files live. Local disk under UPLOAD_DIR now; an S3 backend only has to implement the same four methods
(the workers would download to a temporary file in `local_path` and upload results in `put_file`)."""

import shutil
import uuid
from pathlib import Path
from typing import BinaryIO, Protocol

from app.config import get_settings


class TooLarge(Exception):
    pass


class Storage(Protocol):
    def save_stream(self, src: BinaryIO, folder: str, ext: str, max_bytes: int) -> str: ...
    def local_path(self, key: str) -> Path: ...
    def put_file(self, path: Path, folder: str, ext: str) -> str: ...
    def delete(self, key: str) -> None: ...


class LocalStorage:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def _new_key(self, folder: str, ext: str) -> str:
        (self.root / folder).mkdir(parents=True, exist_ok=True)
        return f"{folder}/{uuid.uuid4().hex}{ext}"

    def save_stream(self, src: BinaryIO, folder: str, ext: str, max_bytes: int) -> str:
        """Copies in 1 MB pieces and stops as soon as the file goes over the limit (never holds it in memory)."""
        key = self._new_key(folder, ext)
        dest = self.root / key
        written = 0
        try:
            with dest.open("wb") as out:
                while chunk := src.read(1 << 20):
                    written += len(chunk)
                    if written > max_bytes:
                        raise TooLarge()
                    out.write(chunk)
        except BaseException:
            dest.unlink(missing_ok=True)
            raise
        return key

    def local_path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root not in p.parents:
            raise ValueError("bad key")
        return p

    def put_file(self, path: Path, folder: str, ext: str) -> str:
        key = self._new_key(folder, ext)
        shutil.move(str(path), self.root / key)
        return key

    def delete(self, key: str) -> None:
        try:
            self.local_path(key).unlink(missing_ok=True)
        except ValueError:
            pass


def get_storage() -> Storage:
    return LocalStorage(get_settings().upload_dir)
