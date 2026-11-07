"""Perceptual hashes of video frames, built to survive the edits re-uploaders make.

Each sampled frame keeps four 64-bit pHashes (as hex):
  h  — the whole frame, after black/plain borders are trimmed (survives letterboxing, padding, scaling, colour filters)
  c  — the centre 70 % (survives cropping and zooming, overlays/watermarks in the corners)
  t  — the top 62 % (survives lower thirds, tickers, subtitles and other overlays a streamer adds at the bottom)
  hf, cf, tf — the same for the mirrored frame (survives horizontal flips)
"""

from pathlib import Path

import imagehash
import numpy as np
from PIL import Image, ImageOps

CENTRE = 0.70
TOP = 0.62


def trim_borders(img: Image.Image, tolerance: float = 12.0) -> Image.Image:
    """Removes uniform bars (black, white or any plain colour) on any side."""
    a = np.asarray(img.convert("L"), dtype=np.float32)
    h, w = a.shape
    if h < 16 or w < 16:
        return img
    rows = a.std(axis=1) > tolerance
    cols = a.std(axis=0) > tolerance
    # A row also counts as content when it differs from the corner colour (a flat but coloured picture region).
    corner = float(np.median([a[0, 0], a[0, -1], a[-1, 0], a[-1, -1]]))
    rows |= np.abs(a.mean(axis=1) - corner) > tolerance
    cols |= np.abs(a.mean(axis=0) - corner) > tolerance
    ys, xs = np.flatnonzero(rows), np.flatnonzero(cols)
    if len(ys) < h * 0.3 or len(xs) < w * 0.3:  # mostly plain picture: keep it whole
        return img
    return img.crop((int(xs[0]), int(ys[0]), int(xs[-1]) + 1, int(ys[-1]) + 1))


def centre(img: Image.Image, part: float = CENTRE) -> Image.Image:
    w, h = img.size
    dx, dy = int(w * (1 - part) / 2), int(h * (1 - part) / 2)
    return img.crop((dx, dy, w - dx, h - dy))


def top(img: Image.Image, part: float = TOP) -> Image.Image:
    w, h = img.size
    return img.crop((0, 0, w, int(h * part)))


def frame_hashes(path: Path) -> dict[str, str]:
    with Image.open(path) as raw:
        img = trim_borders(raw.convert("RGB"))
    mirrored = ImageOps.mirror(img)
    return {
        "h": str(imagehash.phash(img)),
        "c": str(imagehash.phash(centre(img))),
        "hf": str(imagehash.phash(mirrored)),
        "cf": str(imagehash.phash(centre(mirrored))),
        "t": str(imagehash.phash(top(img))),
        "tf": str(imagehash.phash(top(mirrored))),
    }


def hash_frames(frames: list[tuple[float, Path]]) -> list[dict]:
    """[{at: seconds, h, c, t, hf, cf, tf}, …] — the `video_phash_list` stored with a video."""
    return [{"at": round(t, 2), **frame_hashes(p)} for t, p in frames]


def to_ints(hexes: list[str]) -> np.ndarray:
    return np.array([int(x, 16) for x in hexes], dtype=np.uint64)


def hamming(a: str, b: str) -> int:
    return (int(a, 16) ^ int(b, 16)).bit_count()
