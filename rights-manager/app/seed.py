"""Test data: two accounts and one protected video.

    python -m app.seed

Makes the accounts `creator` (owns the protected video) and `admin` (administrator; can also upload to try
the checks). Passwords come from SEED_PASSWORD, or a random one is made and printed. The video is made with
FFmpeg (an animated pattern with a tune), so no outside file is needed. Running it again changes nothing.
"""

import os
import secrets
import shutil
import subprocess
import tempfile
from pathlib import Path

from sqlalchemy import select

from app.db import SessionLocal, init_db
from app.models import Policy, ReferenceVideo, Role, User
from app.security import hash_password
from app.storage import get_storage
from app.workers.tasks import process_reference


def make_video(out: Path) -> None:
    subprocess.run([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i", "mandelbrot=s=640x360:rate=25",
        "-f", "lavfi", "-i", "aevalsrc='0.4*sin(2*PI*(220+110*floor(mod(t,4)))*t)+0.3*sin(2*PI*(330+55*floor(mod(t*1.5,5)))*t)':s=44100",
        "-t", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(out),
    ], check=True)


def main() -> None:
    init_db()
    password = os.environ.get("SEED_PASSWORD") or secrets.token_urlsafe(9)
    with SessionLocal() as db:
        made = []
        for name, role in (("creator", Role.creator), ("admin", Role.admin)):
            if db.scalar(select(User).where(User.username == name)) is None:
                db.add(User(username=name, email=f"{name}@rights.local", password_hash=hash_password(password), role=role))
                made.append(name)
        db.commit()
        creator = db.scalar(select(User).where(User.username == "creator"))
        has_ref = db.scalar(select(ReferenceVideo).where(ReferenceVideo.owner_id == creator.id))
        ref_id = None
        if has_ref is None:
            work = Path(tempfile.mkdtemp())
            try:
                make_video(work / "original.mp4")
                with (work / "original.mp4").open("rb") as f:
                    key = get_storage().save_stream(f, "references", ".mp4", 1 << 30)
            finally:
                shutil.rmtree(work, ignore_errors=True)
            ref = ReferenceVideo(owner_id=creator.id, title="Mandelbrot zoom (seed)", file_path=key, policy=Policy.Block)
            db.add(ref)
            db.commit()
            ref_id = ref.id

    if ref_id is not None:
        process_reference.apply(args=[ref_id])  # fingerprint here, no worker needed
    print("Accounts:", ", ".join(made) if made else "already there (passwords unchanged)")
    if made:
        print(f"Password for {', '.join(made)}: {password}")
    print("Protected video:", "added and fingerprinted" if ref_id else "already there")


if __name__ == "__main__":
    main()
