"""FFmpeg work on a video: facts about the file, its SHA-256, a thumbnail and one frame every few seconds."""

import hashlib
import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from app.config import get_settings


class VideoError(Exception):
    """The file cannot be read as a video."""


@dataclass
class VideoInfo:
    duration: float
    width: int
    height: int
    has_audio: bool


def run(args: list[str], timeout: int = 1800) -> subprocess.CompletedProcess:
    p = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    if p.returncode != 0:
        raise VideoError(p.stderr.decode(errors="replace")[-500:].strip() or f"{args[0]} failed")
    return p


def probe(path: Path) -> VideoInfo:
    out = run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], 120).stdout
    data = json.loads(out or b"{}")
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise VideoError("This file has no video picture.")
    duration = float(data.get("format", {}).get("duration") or video.get("duration") or 0)
    if duration <= 0:
        raise VideoError("This video has no length.")
    return VideoInfo(duration, int(video.get("width") or 0), int(video.get("height") or 0), any(s.get("codec_type") == "audio" for s in streams))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def make_thumbnail(path: Path, duration: float) -> Path:
    """A 480 px wide JPEG from a tenth of the way in (past black openings), in a temporary file."""
    out = Path(tempfile.mkstemp(suffix=".jpg")[1])
    at = min(max(duration * 0.1, 0), max(duration - 0.1, 0))
    run(["ffmpeg", "-y", "-v", "error", "-ss", f"{at:.2f}", "-i", str(path), "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", str(out)], 120)
    if out.stat().st_size == 0:  # a seek past the last frame: take the first one
        run(["ffmpeg", "-y", "-v", "error", "-i", str(path), "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", str(out)], 120)
    return out


def extract_frames(path: Path, every: float | None = None) -> tuple[Path, list[tuple[float, Path]]]:
    """One frame every `every` seconds (FRAME_EVERY_SEC, 2 s by default) into a fresh folder under FRAME_DIR.
    Returns the folder (delete it when done) and (time, file) for each frame."""
    s = get_settings()
    every = every or s.frame_every_sec
    s.frame_dir.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix="f-", dir=s.frame_dir))
    try:
        # Small greyscale frames are all a perceptual hash needs; 320 px keeps the work light for long videos.
        run(["ffmpeg", "-y", "-v", "error", "-i", str(path), "-vf", f"fps=1/{every}:round=down,scale=320:-2", "-fps_mode", "passthrough", str(folder / "%06d.png")])
        files = sorted(folder.glob("*.png"))
        if not files:  # shorter than one step
            run(["ffmpeg", "-y", "-v", "error", "-i", str(path), "-frames:v", "1", "-vf", "scale=320:-2", str(folder / "000001.png")])
            files = sorted(folder.glob("*.png"))
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return folder, [(i * every, f) for i, f in enumerate(files)]


def strip_audio(path: Path) -> Path:
    """A copy with the sound removed and the picture untouched (the Mute policy)."""
    out = Path(tempfile.mkstemp(suffix=path.suffix)[1])
    run(["ffmpeg", "-y", "-v", "error", "-i", str(path), "-map", "0:v", "-c", "copy", "-an", str(out)])
    return out
