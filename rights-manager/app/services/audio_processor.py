"""Sound: FFmpeg pulls a mono WAV out of the video, Chromaprint (through pyacoustid) turns it into a fingerprint.

A raw Chromaprint fingerprint is a list of 32-bit numbers, about 8 per second, each describing the sound's
pitch classes at that moment. Two copies of the same recording give near-identical numbers at the same offset.

Re-uploaders change speed (0.8–1.25×) and pitch (±10 %), which shifts and stretches those numbers. An upload's
fingerprint therefore also carries variants: the upload's sound run back through the opposite change, so one of
them lines up with the original again.
"""

import json
import shutil
import tempfile
import wave
from pathlib import Path

import chromaprint  # part of pyacoustid; uses the system libchromaprint

from app.services.video_processor import run

RATE = 11025  # Chromaprint works at 11025 Hz internally; extracting at that rate skips a resample.

# Speeds a re-upload may use. Each is undone two ways: tempo only (pitch kept, how most editors speed up) and
# resampling (pitch moves with speed, like a sped-up record).
SPEEDS = (0.8, 0.85, 0.9, 0.95, 1.05, 1.1, 1.15, 1.2, 1.25)
# Pitch shifts a re-upload may use with the tempo kept.
PITCHES = (0.9, 0.95, 1.05, 1.1)


def _variant_filters() -> dict[str, str]:
    f: dict[str, str] = {}
    for s in SPEEDS:
        f[f"tempo:{s}"] = f"atempo={1 / s:.6f}"
        f[f"rate:{s}"] = f"asetrate={RATE / s:.3f},aresample={RATE}"
    for p in PITCHES:
        # asetrate by 1/p moves the pitch back; atempo by p puts the length back where it was.
        f[f"pitch:{p}"] = f"asetrate={RATE / p:.3f},aresample={RATE},atempo={p:.6f}"
    return f


VARIANTS = _variant_filters()


def extract_wav(video: Path, out: Path) -> bool:
    """Mono 11025 Hz 16-bit WAV. False when the video has no sound."""
    try:
        run(["ffmpeg", "-y", "-v", "error", "-i", str(video), "-vn", "-ac", "1", "-ar", str(RATE), "-sample_fmt", "s16", str(out)])
    except Exception:
        return False
    return out.exists() and out.stat().st_size > 44 + RATE  # more than half a second of samples


def fingerprint_wav(path: Path) -> list[int]:
    """The raw Chromaprint fingerprint of the whole file (no 2-minute cap as fpcalc has by default)."""
    with wave.open(str(path), "rb") as w:
        fp = chromaprint.Fingerprinter()
        fp.start(w.getframerate(), w.getnchannels())
        while frames := w.readframes(1 << 16):
            fp.feed(frames)
        encoded = fp.finish()
    raw, _algorithm = chromaprint.decode_fingerprint(encoded)
    # Stored unsigned, so XOR + popcount in the matcher need no sign handling.
    return [x & 0xFFFFFFFF for x in raw]


def audio_fingerprint(video: Path, with_variants: bool) -> str | None:
    """JSON {"base": [...], "variants": {"tempo:1.2": [...], ...}}; None when there is no sound."""
    work = Path(tempfile.mkdtemp(prefix="audio-"))
    try:
        base_wav = work / "base.wav"
        if not extract_wav(video, base_wav):
            return None
        base = fingerprint_wav(base_wav)
        if len(base) < 8:  # under about a second of usable sound
            return None
        out: dict = {"base": base}
        if with_variants:
            variants = {}
            for name, filt in VARIANTS.items():
                vw = work / "v.wav"
                run(["ffmpeg", "-y", "-v", "error", "-i", str(base_wav), "-af", filt, "-ac", "1", "-ar", str(RATE), "-sample_fmt", "s16", str(vw)])
                variants[name] = fingerprint_wav(vw)
            out["variants"] = variants
        return json.dumps(out, separators=(",", ":"))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def load(fp: str | None) -> dict | None:
    return json.loads(fp) if fp else None
