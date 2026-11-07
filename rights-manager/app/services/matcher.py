"""Compares an upload with an original and scores how much of it is that original (0–100).

Video: every sampled frame of the upload is matched with its closest frame of the original by pHash Hamming
distance, trying the whole frame, the centre, and both mirrored, so crops, flips, colour filters and speed
changes (a different frame lands nearest, but still a near-identical one) keep scoring high.

Audio: windows of the upload's Chromaprint fingerprint (and of each speed/pitch variant) slide along the
original's to find where they line up; the share of equal bits there becomes the score.

combined = video × 0.6 + audio × 0.4 (video alone when either side has no sound).
"""

from dataclasses import dataclass

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from app.services import audio_processor

# Frame distance (of 64 bits) at or under which two frames are the same picture, and from which they are unrelated.
SAME_FRAME = 10
OTHER_FRAME = 22

# Audio: windows of ~10 s (Chromaprint gives ~8 values a second), moved ~5 s at a time.
WINDOW = 80
STEP = 40
# Share of equal bits in a window's best alignment: unrelated sound reaches about LOW, the same recording HIGH.
AUDIO_LOW = 0.66
AUDIO_HIGH = 0.88

VIDEO_WEIGHT = 0.6
AUDIO_WEIGHT = 0.4


@dataclass
class Scores:
    video: float
    audio: float | None
    combined: float
    exact: bool = False


def _hashes(lst: list[dict], key: str) -> np.ndarray:
    return np.array([int(f[key], 16) for f in lst], dtype=np.uint64)


def frame_distances(upload: list[dict], reference: list[dict]) -> np.ndarray:
    """For each upload frame, the smallest Hamming distance to any reference frame (any of the four hashes)."""
    ref = np.concatenate([_hashes(reference, k) for k in ("h", "c", "hf", "cf")])
    best = np.full(len(upload), 64, dtype=np.int64)
    for key in ("h", "c"):
        up = _hashes(upload, key)
        d = np.bitwise_count(up[:, None] ^ ref[None, :]).min(axis=1).astype(np.int64)
        best = np.minimum(best, d)
    return best


def video_similarity(upload: list[dict] | None, reference: list[dict] | None) -> float:
    if not upload or not reference:
        return 0.0
    d = frame_distances(upload, reference)
    per_frame = np.clip((OTHER_FRAME - d) / (OTHER_FRAME - SAME_FRAME), 0.0, 1.0)
    return round(float(per_frame.mean()) * 100, 1)


def _best_alignment(window: np.ndarray, ref: np.ndarray) -> float:
    """Share of equal bits where `window` lines up best along `ref` (it may also hang over either end a little)."""
    n = len(window)
    if len(ref) < n:  # the original is shorter than the window: slide the original along the window instead
        window, ref = ref, window
        n = len(window)
    views = sliding_window_view(ref, n)
    diff = np.bitwise_count(views ^ window[None, :]).sum(axis=1)
    return 1.0 - float(diff.min()) / (32 * n)


def fingerprint_similarity(up: list[int], ref: list[int]) -> float:
    """Average best-alignment bit agreement over the upload's windows (0–1)."""
    u = np.array(up, dtype=np.uint32)
    r = np.array(ref, dtype=np.uint32)
    if len(u) < 16 or len(r) < 16:
        return 0.0
    w = min(WINDOW, len(u), len(r))
    starts = range(0, max(len(u) - w, 0) + 1, STEP if len(u) > w else 1)
    sims = [_best_alignment(u[s : s + w], r) for s in starts]
    return float(np.mean(sims))


def audio_similarity(upload_fp: str | None, reference_fp: str | None) -> float | None:
    """0–100, or None when either has no sound. Tries the upload as is and every speed/pitch variant."""
    up, ref = audio_processor.load(upload_fp), audio_processor.load(reference_fp)
    if not up or not ref:
        return None
    candidates = [up["base"], *up.get("variants", {}).values()]
    best = max(fingerprint_similarity(c, ref["base"]) for c in candidates)
    return round(float(np.clip((best - AUDIO_LOW) / (AUDIO_HIGH - AUDIO_LOW), 0.0, 1.0)) * 100, 1)


def combine(video: float, audio: float | None) -> float:
    if audio is None:
        return round(video, 1)
    return round(video * VIDEO_WEIGHT + audio * AUDIO_WEIGHT, 1)


def compare(upload: dict, reference: dict) -> Scores:
    """`upload` and `reference` hold sha, hashes (video_phash_list) and audio (audio_fingerprint)."""
    if upload.get("sha") and upload["sha"] == reference.get("sha"):
        return Scores(100.0, 100.0 if reference.get("audio") else None, 100.0, exact=True)
    v = video_similarity(upload.get("hashes"), reference.get("hashes"))
    a = audio_similarity(upload.get("audio"), reference.get("audio"))
    return Scores(v, a, combine(v, a))
