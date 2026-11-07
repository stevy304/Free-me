"""Test setup: a separate database, files in a temporary folder, Celery tasks run in-process, and real videos made
with FFmpeg (no files are checked in)."""

import os
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(tempfile.mkdtemp(prefix="rm-tests-"))
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL", "postgresql+psycopg://rights:rights@127.0.0.1:5432/rights_test")
os.environ["UPLOAD_DIR"] = str(ROOT / "uploads")
os.environ["FRAME_DIR"] = str(ROOT / "frames")
os.environ["CELERY_EAGER"] = "true"
os.environ["JWT_SECRET"] = "test-secret-that-is-long-enough-for-hs256"

VIDEOS = ROOT / "videos"
FONT = next((p for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf") if Path(p).exists()), None)

# A moving picture with changing tones, and two unrelated videos.
ORIGINAL = [
    "-f", "lavfi", "-i", "mandelbrot=s=640x360:rate=25",
    "-f", "lavfi", "-i", "aevalsrc='0.4*sin(2*PI*(220+110*floor(mod(t,4)))*t)+0.3*sin(2*PI*(330+55*floor(mod(t*1.5,5)))*t)*(0.5+0.5*sin(2*PI*0.5*t))':s=44100",
]
OTHER = [
    "-f", "lavfi", "-i", "life=s=640x360:mold=10:r=25:ratio=0.1:death_color=#C83232:life_color=#00ff00",
    "-f", "lavfi", "-i", "anoisesrc=c=pink:a=0.3:r=44100",
]
OTHER2 = [
    "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25",
    "-f", "lavfi", "-i", "aevalsrc='0.5*sin(2*PI*(400+200*floor(mod(t*2,3)))*t)':s=44100",
]


def ff(*args: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True)


@pytest.fixture(scope="session")
def videos() -> dict[str, Path]:
    VIDEOS.mkdir(parents=True, exist_ok=True)
    v = {k: VIDEOS / f"{k}.mp4" for k in ("original", "copy", "hflip", "speed12", "other", "other2", "tiktok", "mute_src")}
    enc = ["-t", "20", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]
    ff(*ORIGINAL, *enc, str(v["original"]))
    v["copy"].write_bytes(v["original"].read_bytes())
    ff("-i", str(v["original"]), "-vf", "hflip", "-c:a", "copy", str(v["hflip"]))
    ff("-i", str(v["original"]), "-filter_complex", "[0:v]setpts=PTS/1.2[v];[0:a]atempo=1.2[a]", "-map", "[v]", "-map", "[a]", str(v["speed12"]))
    ff(*OTHER, *enc, str(v["other"]))
    ff(*OTHER2, *enc, str(v["other2"]))
    mark = f"drawtext=fontfile={FONT}:text='TikTok':fontcolor=white:fontsize=30:borderw=2:bordercolor=black:x=w-tw-20:y=h-th-20"
    ff("-i", str(v["other2"]), "-vf", mark, "-c:a", "copy", str(v["tiktok"]))
    # A re-encode of the original (not byte-identical), for policy tests where the exact-file shortcut must not apply.
    ff("-i", str(v["original"]), "-vf", "scale=600:-2", "-c:a", "aac", "-b:a", "96k", str(v["mute_src"]))
    return v
