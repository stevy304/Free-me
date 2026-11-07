"""Finds re-upload watermarks ("TikTok", "CapCut", "YouTube") in the corners of a video's frames.

OCR (Tesseract through pytesseract) reads each corner, as is and inverted, since these marks are usually white
text with a dark outline. When Tesseract is not installed, OpenCV template matching with the words drawn in
several sizes is used instead (less tolerant of unusual fonts).
"""

import logging
import os
import re
import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

from app.services.video_processor import run

log = logging.getLogger(__name__)
# Tesseract would start a thread per core for every corner; four corners at once then fight over the CPU.
os.environ.setdefault("OMP_THREAD_LIMIT", "1")

WORDS = ("tiktok", "capcut", "youtube")
LABELS = {"tiktok": "TikTok", "capcut": "CapCut", "youtube": "YouTube"}
SAMPLES = 6  # frames read per video, spread over its length
CORNER_W, CORNER_H = 0.40, 0.28  # share of width/height a corner covers

try:
    import pytesseract

    HAS_OCR = shutil.which("tesseract") is not None
except ImportError:  # pragma: no cover
    HAS_OCR = False


def _sample_frames(video: Path, duration: float, folder: Path) -> list[Path]:
    out = []
    for i in range(SAMPLES):
        at = duration * (i + 0.5) / SAMPLES
        p = folder / f"w{i}.png"
        try:
            run(["ffmpeg", "-y", "-v", "error", "-ss", f"{at:.2f}", "-i", str(video), "-frames:v", "1", "-vf", "scale=1280:-2", str(p)], 120)
        except Exception:
            continue
        if p.exists() and p.stat().st_size:
            out.append(p)
    return out


def corners(img: np.ndarray) -> list[np.ndarray]:
    h, w = img.shape[:2]
    cw, ch = int(w * CORNER_W), int(h * CORNER_H)
    return [img[:ch, :cw], img[:ch, w - cw :], img[h - ch :, :cw], img[h - ch :, w - cw :]]


def _edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def find_word(text: str) -> str | None:
    """The watermark word in OCR text, allowing one misread letter ("Tik Tok", "TikT0k", "@user · TikTok")."""
    low = text.lower().replace("0", "o")
    joined = re.sub(r"[^a-z]", "", low)  # "Tik Tok" → "tiktok"
    for word in WORDS:
        if word in joined:
            return word
    for token in re.findall(r"[a-z]+", low):
        for word in WORDS:
            if abs(len(token) - len(word)) <= 1 and _edit_distance(token, word) <= 1:
                return word
    return None


def white_text(region: np.ndarray) -> np.ndarray:
    """Black-on-white image of the near-white, colourless pixels: platform marks are white text, so this drops a
    busy, colourful background that would otherwise drown the letters."""
    hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
    mask = ((hsv[:, :, 2] > 190) & (hsv[:, :, 1] < 50)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    return 255 - mask


def _ocr(region: np.ndarray) -> str | None:
    region = cv2.resize(region, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    for img in (white_text(region), gray, 255 - gray):
        if word := find_word(pytesseract.image_to_string(img, config="--psm 11")):
            return word
    return None


_templates: dict[str, list[np.ndarray]] = {}


def _word_templates(word: str) -> list[np.ndarray]:
    if word not in _templates:
        label = LABELS[word]
        out = []
        for scale in (0.6, 0.8, 1.0, 1.3, 1.6):
            (tw, th), base = cv2.getTextSize(label, cv2.FONT_HERSHEY_DUPLEX, scale, 2)
            t = np.zeros((th + base + 6, tw + 6), np.uint8)
            cv2.putText(t, label, (3, th + 3), cv2.FONT_HERSHEY_DUPLEX, scale, 255, 2, cv2.LINE_AA)
            out.append(t)
        _templates[word] = out
    return _templates[word]


def _template(region: np.ndarray, threshold: float = 0.72) -> str | None:
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    for img in (gray, 255 - gray):
        for word in WORDS:
            for t in _word_templates(word):
                if t.shape[0] > img.shape[0] or t.shape[1] > img.shape[1]:
                    continue
                if cv2.matchTemplate(img, t, cv2.TM_CCOEFF_NORMED).max() >= threshold:
                    return word
    return None


def detect_in_image(img: np.ndarray) -> str | None:
    """The four corners are read at the same time (Tesseract runs as separate processes)."""
    read = _ocr if HAS_OCR else _template
    with ThreadPoolExecutor(4) as pool:
        for word in pool.map(read, corners(img)):
            if word:
                return word
    return None


def detect(video: Path, duration: float) -> str | None:
    """The watermark found ("TikTok", "CapCut" or "YouTube"), or None."""
    folder = Path(tempfile.mkdtemp(prefix="wm-"))
    try:
        # Busy pictures hide the mark in some frames, so one clear reading is enough.
        for p in _sample_frames(video, duration, folder):
            img = cv2.imread(str(p))
            if img is not None and (word := detect_in_image(img)):
                return LABELS[word]
        return None
    except Exception:  # OCR trouble never fails the upload check
        log.exception("watermark check failed")
        return None
    finally:
        shutil.rmtree(folder, ignore_errors=True)
