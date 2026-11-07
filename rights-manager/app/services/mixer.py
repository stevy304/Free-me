"""The live control room's engine: one FFmpeg process per live stream that turns the creator's inputs into the
program everyone sees.

Inputs (all pulled from the local RTMP server):
  cam1 = the stream key itself (OBS / Streamlabs / vMix / Larix), cam2..cam4 = <key>-cam2..4 (more encoders),
  screen = <key>-screen and guest = <key>-guest (published from the browser), plus
  an overlay PNG (lower third, chat box, alerts, full-screen cards for Intro/BRB/Ending) re-read 5×/s,
  and two raw-audio FIFOs fed in real time by this process: music and sound effects.

Live control without restarting (FFmpeg's zmq filter): `streamselect@sel map N` switches the program camera,
`volume@ch_<name> volume X` moves a mixer fader, `eq@fx brightness B` draws Fade/Stinger transitions.
Levels: every channel is measured (astats) into a FIFO this process reads, for the VU meters.

Outputs (tee): RTMP <key>-program (what restreams read), HLS for the browser preview and viewers, and an MPEG-TS
recording that becomes the VOD.
"""

from __future__ import annotations

import logging
import math
import os
import queue
import shutil
import socket
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import zmq
from PIL import Image, ImageDraw, ImageFont

from app.config import get_settings

log = logging.getLogger(__name__)

RATE = 48000
SOURCES = ("cam1", "cam2", "cam3", "cam4", "screen", "guest")
SUFFIX = {"cam1": "", "cam2": "-cam2", "cam3": "-cam3", "cam4": "-cam4", "screen": "-screen", "guest": "-guest"}
# Which fader each source's sound goes through.
CHANNEL_OF = {"cam1": "mic1", "cam2": "mic2", "cam3": "mic2", "cam4": "mic2", "guest": "guest", "screen": "desktop"}
CHANNELS = ("mic1", "mic2", "guest", "music", "sfx", "desktop", "master")
CHANNEL_LABEL = {"mic1": "Mic 1", "mic2": "Mic 2", "guest": "Guest", "music": "Music", "sfx": "Sound Effects", "desktop": "Desktop Audio", "master": "MASTER"}
TRANSITIONS = ("cut", "fade", "stinger")


def default_state() -> dict:
    return {
        "scene": "Main",
        "program": "cam1",
        "transition": "fade",
        "scenes": [
            {"name": "Intro", "card": "intro"},
            {"name": "Main", "source": "cam1"},
            {"name": "Interview", "source": "interview"},
            {"name": "BRB", "card": "brb", "mute": ["mic1", "mic2", "guest"]},
            {"name": "Ending", "card": "ending"},
        ],
        "cards": {
            "intro": {"title": "Starting soon", "subtitle": ""},
            "brb": {"title": "Be right back", "subtitle": ""},
            "ending": {"title": "Thanks for watching", "subtitle": ""},
        },
        "mixer": {c: {"volume": 1.0, "muted": False} for c in CHANNELS},
        "scene_mutes": [],
        "lower_third": {"enabled": False, "name": "", "title": ""},
        "chat_box": False,
        "alerts": True,
        "camera_off": [],
    }


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---- overlay ---------------------------------------------------------------------------------------------------------

def _font(size: int, bold: bool = False):
    for name in ("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf",):
        for folder in ("/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/TTF", "/usr/share/fonts/dejavu"):
            p = Path(folder) / name
            if p.exists():
                return ImageFont.truetype(str(p), size)
    return ImageFont.load_default()


def render_overlay(state: dict, chat: list[dict], alert: dict | None, w: int, h: int, active_card: str | None, title: str) -> Image.Image:
    """Everything drawn over the program, as one transparent PNG."""
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = h / 720
    if active_card:
        card = state.get("cards", {}).get(active_card, {})
        top, bottom = {"intro": ((24, 32, 72), (88, 40, 140)), "brb": ((18, 18, 24), (60, 60, 80)), "ending": ((70, 20, 40), (20, 20, 60)), "camoff": ((10, 10, 10), (30, 30, 30))}.get(active_card, ((20, 20, 30), (50, 50, 70)))
        for y in range(h):
            t = y / h
            d.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
        big = card.get("title") or {"camoff": "Camera off"}.get(active_card, title)
        f1, f2 = _font(int(64 * s), True), _font(int(30 * s))
        d.text((w / 2, h / 2 - 20 * s), big, font=f1, fill="white", anchor="mm")
        sub = card.get("subtitle") or (title if active_card in ("intro", "ending") else "")
        if sub:
            d.text((w / 2, h / 2 + 50 * s), sub, font=f2, fill=(220, 220, 230), anchor="mm")
        return img
    lt = state.get("lower_third") or {}
    if lt.get("enabled") and (lt.get("name") or lt.get("title")):
        x, y, bw, bh = int(48 * s), int(h - 170 * s), int(620 * s), int(96 * s)
        d.rectangle((x, y, x + bw, y + bh), fill=(15, 15, 25, 225))
        d.rectangle((x, y, x + int(8 * s), y + bh), fill=(239, 68, 68, 255))
        d.text((x + 28 * s, y + 18 * s), lt.get("name", ""), font=_font(int(34 * s), True), fill="white")
        d.text((x + 28 * s, y + 58 * s), lt.get("title", ""), font=_font(int(22 * s)), fill=(210, 210, 220))
    if state.get("chat_box") and chat:
        x0, y0, cw = int(w - 440 * s), int(40 * s), int(400 * s)
        rows = chat[-6:]
        d.rounded_rectangle((x0, y0, x0 + cw, y0 + int((44 + 38 * len(rows)) * s)), radius=int(14 * s), fill=(10, 10, 18, 200))
        d.text((x0 + 18 * s, y0 + 12 * s), "Live chat", font=_font(int(20 * s), True), fill=(255, 255, 255))
        f = _font(int(19 * s))
        for i, m in enumerate(rows):
            text = f"{m['username']}: {m['text']}"
            text = text if len(text) <= 42 else text[:41] + "…"
            d.text((x0 + 18 * s, y0 + (46 + 38 * i) * s), text, font=f, fill=(235, 235, 245))
    if alert and state.get("alerts", True):
        msg = alert["text"]
        f = _font(int(40 * s), True)
        tw = d.textlength(msg, font=f)
        bx = (w - tw) / 2 - 40 * s
        d.rounded_rectangle((bx, 60 * s, w - bx, 150 * s), radius=int(20 * s), fill=(245, 158, 11, 235))
        d.text((w / 2, 105 * s), msg, font=f, fill=(20, 20, 20), anchor="mm")
    return img


# ---- sound -----------------------------------------------------------------------------------------------------------

def _env(n: int, attack: float = 0.01, release: float = 0.2) -> np.ndarray:
    t = np.arange(n) / RATE
    e = np.minimum(1, t / attack) * np.minimum(1, (t[-1] - t) / release + 1e-9)
    return np.clip(e, 0, 1)


def synth_effects() -> dict[str, np.ndarray]:
    """Built-in sound effects, made here (no sample files): stereo int16 at 48 kHz."""
    rng = np.random.default_rng(7)

    def stereo(x: np.ndarray) -> np.ndarray:
        x = np.clip(x, -1, 1)
        return (np.repeat(x[:, None], 2, axis=1) * 32767 * 0.8).astype(np.int16)

    t = lambda sec: np.arange(int(RATE * sec)) / RATE  # noqa: E731
    ding = sum(np.sin(2 * np.pi * f * t(1.2)) * a for f, a in ((880, 0.6), (1760, 0.25), (2640, 0.1))) * np.exp(-t(1.2) * 3)
    horn = np.sign(np.sin(2 * np.pi * 415 * t(1.0))) * 0.4 + np.sign(np.sin(2 * np.pi * 523 * t(1.0))) * 0.3
    horn = horn * _env(len(horn), 0.02, 0.15)
    claps = np.zeros(int(RATE * 2.0))
    for start in rng.uniform(0, 1.8, 90):
        i = int(start * RATE)
        burst = rng.normal(0, 1, int(RATE * 0.03)) * np.exp(-np.arange(int(RATE * 0.03)) / (RATE * 0.006))
        claps[i:i + len(burst)] += burst[: len(claps) - i] * 0.35
    claps *= _env(len(claps), 0.05, 0.6)
    roll_t = t(2.0)
    roll = rng.normal(0, 1, len(roll_t)) * (0.5 + 0.5 * np.sin(2 * np.pi * 28 * roll_t)) * np.minimum(1, roll_t / 1.5) * 0.4
    roll[-int(RATE * 0.25):] += np.sin(2 * np.pi * 60 * t(0.25)) * np.exp(-t(0.25) * 12)
    tada = np.concatenate([np.sin(2 * np.pi * f * t(d)) * _env(int(RATE * d), 0.01, 0.1) * 0.5 for f, d in ((523, 0.15), (659, 0.15), (784, 0.5))])
    return {"Ding": stereo(ding), "Air horn": stereo(horn), "Applause": stereo(claps), "Drum roll": stereo(roll), "Ta-da": stereo(tada)}


class AudioFeed(threading.Thread):
    """Writes stereo PCM into a FIFO at real-time speed: silence, plus whatever is queued (effects overlap)."""

    CHUNK = RATE // 50  # 20 ms

    def __init__(self, path: Path, stop: threading.Event):
        super().__init__(daemon=True)
        self.path, self.stop_event = path, stop
        self.playing: list[list] = []  # [samples, position]
        self.loop: np.ndarray | None = None
        self.loop_pos = 0
        self.lock = threading.Lock()

    def play(self, samples: np.ndarray) -> None:
        with self.lock:
            self.playing.append([samples, 0])

    def set_loop(self, samples: np.ndarray | None) -> None:
        with self.lock:
            self.loop, self.loop_pos = samples, 0

    def _next(self) -> bytes:
        out = np.zeros((self.CHUNK, 2), np.int32)
        with self.lock:
            if self.loop is not None and len(self.loop):
                need, filled = self.CHUNK, 0
                while need:
                    take = min(need, len(self.loop) - self.loop_pos)
                    out[filled:filled + take] += self.loop[self.loop_pos:self.loop_pos + take]
                    self.loop_pos = (self.loop_pos + take) % len(self.loop)
                    filled += take
                    need -= take
            for item in self.playing:
                samples, pos = item
                take = min(self.CHUNK, len(samples) - pos)
                out[:take] += samples[pos:pos + take]
                item[1] += take
            self.playing = [p for p in self.playing if p[1] < len(p[0])]
        return np.clip(out, -32768, 32767).astype(np.int16).tobytes()

    def run(self) -> None:
        try:
            with open(self.path, "wb", buffering=0) as f:
                start, n = time.monotonic(), 0
                while not self.stop_event.is_set():
                    f.write(self._next())
                    n += 1
                    # 100 ms ahead of real time, so FFmpeg never waits for this input.
                    delay = start + n / 50 - 0.1 - time.monotonic()
                    if delay > 0:
                        time.sleep(delay)
        except (BrokenPipeError, OSError):
            pass


METER = "[ametadata@meter_"


def parse_meter(line: str) -> tuple[str, float] | None:
    """'[ametadata@meter_mic1 @ 0x…] lavfi.astats.Overall.Peak_level=-18.06' -> ('mic1', -18.06)."""
    if METER not in line or "Peak_level=" not in line:
        return None
    ch = line[line.index(METER) + len(METER):].split(" ", 1)[0]
    try:
        v = float(line.rsplit("=", 1)[1])
    except ValueError:
        return None
    return ch, (max(-90.0, v) if math.isfinite(v) else -90.0)


@dataclass
class Source:
    name: str
    has_video: bool = True
    has_audio: bool = True
    width: int = 0
    height: int = 0
    fps: float = 0


@dataclass
class Mixer:
    """One running FFmpeg mixer for one live stream."""

    key: str
    playback_id: str
    sources: dict[str, Source]
    work: Path
    hls_dir: Path
    run_no: int
    state: dict
    progress: dict = field(default_factory=dict)
    levels: dict = field(default_factory=dict)
    proc: subprocess.Popen | None = None
    zmq_port: int = 0
    index: dict[str, int] = field(default_factory=dict)  # program source -> streamselect input

    def __post_init__(self):
        s = get_settings()
        self.w, self.h, self.fps = s.live_width, s.live_height, s.live_fps
        self.stop_event = threading.Event()
        self.music = self.sfx = None
        self._zmq_lock = threading.Lock()
        self._sock = None

    # -- building the FFmpeg command --
    def _video_sources(self) -> list[str]:
        return [n for n in SOURCES if n in self.sources and self.sources[n].has_video]

    def interview_pair(self) -> tuple[str, str] | None:
        vids = [n for n in self._video_sources() if n != "screen"]
        if len(vids) < 2:
            return None
        second = "guest" if "guest" in vids else vids[1]
        return (vids[0] if vids[0] != second else vids[1], second)

    def command(self) -> list[str]:
        s = get_settings()
        rtmp = s.rtmp_internal_url.rstrip("/")
        W, H, F = self.w, self.h, self.fps
        # "info" so the level meters (ametadata@meter_*) reach stderr; -nostats keeps the progress line out of it.
        args = ["ffmpeg", "-hide_banner", "-loglevel", "info", "-nostats", "-nostdin", "-y"]
        inputs: list[str] = []
        idx = 0
        input_of: dict[str, int] = {}
        for name in SOURCES:
            if name not in self.sources:
                continue
            args += ["-thread_queue_size", "1024", "-rw_timeout", "15000000", "-fflags", "+genpts", "-i", f"{rtmp}/{self.key}{SUFFIX[name]}"]
            input_of[name] = idx
            idx += 1
        ov = idx
        # -re: read the overlay at real-time pace, so a change shows within 0.2 s instead of after a buffered backlog.
        args += ["-re", "-thread_queue_size", "4", "-f", "image2", "-loop", "1", "-framerate", "5", "-i", str(self.work / "overlay.png")]
        music_in, sfx_in = idx + 1, idx + 2
        for fifo in ("music.fifo", "sfx.fifo"):
            # A short queue keeps effects and music within ~0.1 s of the button press.
            args += ["-thread_queue_size", "8", "-f", "s16le", "-ar", str(RATE), "-ac", "2", "-i", str(self.work / fifo)]

        f: list[str] = []
        vids = self._video_sources()
        pair = self.interview_pair()
        sel_inputs: list[str] = []
        snaps: list[tuple[str, str]] = []
        for name in vids:
            outs = [f"p_{name}", f"s_{name}"]
            if pair and name in pair:
                outs.append(f"i_{name}")
            f.append(
                # Each encoder's clock starts when it connected; the mixer's starts now.
                f"[{input_of[name]}:v]setpts=PTS-STARTPTS,scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,"
                f"fps={F},setsar=1,format=yuv420p,split={len(outs)}" + "".join(f"[{o}]" for o in outs)
            )
            f.append(f"[s_{name}]fps=1,scale=320:180[snap_{name}]")
            snaps.append((name, f"snap_{name}"))
            self.index[name] = len(sel_inputs)
            sel_inputs.append(f"[p_{name}]")
        if pair:
            f.append(f"[i_{pair[0]}][i_{pair[1]}]hstack=2,scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,setsar=1[p_interview]")
            self.index["interview"] = len(sel_inputs)
            sel_inputs.append("[p_interview]")
        # Always one more input: black (streamselect needs two, and "blank" is a useful program too).
        f.append(f"color=c=black:s={W}x{H}:r={F},format=yuv420p,setsar=1[p_black]")
        self.index["black"] = len(sel_inputs)
        sel_inputs.append("[p_black]")
        start = self.index.get(self.state.get("program", "cam1"), 0)
        f.append(f"{''.join(sel_inputs)}streamselect@sel=inputs={len(sel_inputs)}:map={start}[sel]")
        f.append(f"[{ov}:v]format=rgba,scale={W}:{H}[ovl]")
        zmq_addr = f"tcp\\\\://127.0.0.1\\\\:{self.zmq_port}"
        f.append(f"[sel][ovl]overlay=0:0:format=auto,eq@fx=brightness=0,zmq=bind_address={zmq_addr}[vout]")

        # Audio: sources grouped into faders, then music and effects, then the master fader.
        groups: dict[str, list[str]] = {}
        for name, src in self.sources.items():
            if src.has_audio:
                f.append(f"[{input_of[name]}:a]asetpts=PTS-STARTPTS,aresample={RATE}:async=1000,aformat=sample_fmts=fltp:channel_layouts=stereo[ra_{name}]")
                groups.setdefault(CHANNEL_OF[name], []).append(f"[ra_{name}]")
        groups["music"] = [f"[{music_in}:a]"]
        groups["sfx"] = [f"[{sfx_in}:a]"]
        mixed: list[str] = []
        for ch in CHANNELS:
            if ch == "master" or ch not in groups:
                continue
            ins = groups[ch]
            src = f"{''.join(ins)}amix=inputs={len(ins)}:normalize=0:dropout_transition=0," if len(ins) > 1 else f"{ins[0]}"
            chain = f"{src}aformat=sample_fmts=fltp:channel_layouts=stereo," if len(ins) > 1 else f"{src}aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f.append(f"{chain}volume@ch_{ch}={self._gain(ch)},asplit=2[mx_{ch}][m_{ch}]")
            f.append(self._meter(f"m_{ch}", ch))
            mixed.append(f"[mx_{ch}]")
        f.append(f"{''.join(mixed)}amix=inputs={len(mixed)}:normalize=0:dropout_transition=0,volume@ch_master={self._gain('master')},asplit=2[aout][m_master]")
        f.append(self._meter("m_master", "master"))

        args += ["-filter_complex", ";".join(f), "-map", "[vout]", "-map", "[aout]"]
        enc = s.live_encoder
        gop = str(F * 2)
        if "nvenc" in enc:
            args += ["-c:v", enc, "-preset", "p4", "-tune", "ll", "-rc", "cbr"]
        else:
            args += ["-c:v", enc, "-preset", "veryfast", "-tune", "zerolatency"]
        kbps = s.live_bitrate_kbps
        args += ["-b:v", f"{kbps}k", "-maxrate", f"{kbps}k", "-bufsize", f"{kbps * 2}k", "-g", gop, "-keyint_min", gop, "-pix_fmt", "yuv420p",
                 "-c:a", "aac", "-b:a", "160k", "-ar", str(RATE), "-ac", "2"]
        if "nvenc" not in enc:
            args += ["-sc_threshold", "0"]
        hls = (f"[f=hls:hls_time=2:hls_list_size=10:hls_flags=delete_segments+append_list+omit_endlist+independent_segments+discont_start:"
               f"hls_segment_filename={self.hls_dir}/r{self.run_no}_%05d.ts:onfail=ignore]{self.hls_dir}/index.m3u8")
        program = f"[f=flv:onfail=ignore]{rtmp}/{self.key}-program"
        record = f"[f=mpegts:onfail=ignore]{self.work}/rec_{self.run_no:03d}.ts"
        args += ["-f", "tee", f"{program}|{hls}|{record}"]
        for name, label in snaps:
            args += ["-map", f"[{label}]", "-f", "image2", "-update", "1", "-q:v", "6", str(self.work / "snaps" / f"{name}.jpg")]
        args += ["-progress", "pipe:1", "-stats_period", "1"]
        return args

    def _meter(self, label: str, ch: str) -> str:
        # Ten readings a second per channel, printed to the log under this filter's name.
        return f"[{label}]asetnsamples=n=4800:p=0,astats=metadata=1:reset=1,ametadata@meter_{ch}=print:key=lavfi.astats.Overall.Peak_level,anullsink"

    def _gain(self, ch: str) -> float:
        m = self.state.get("mixer", {}).get(ch, {"volume": 1.0, "muted": False})
        muted = m.get("muted") or ch in self.state.get("scene_mutes", [])
        return 0.0 if muted else round(float(m.get("volume", 1.0)), 3)

    # -- running --
    def start(self, effects: dict[str, np.ndarray], chat: list[dict], title: str) -> None:
        self.work.mkdir(parents=True, exist_ok=True)
        (self.work / "snaps").mkdir(exist_ok=True)
        self.hls_dir.mkdir(parents=True, exist_ok=True)
        self.zmq_port = free_port()
        self.effects = effects
        self.update_overlay(chat, None, title)
        for name in ("music.fifo", "sfx.fifo"):
            p = self.work / name
            p.unlink(missing_ok=True)
            os.mkfifo(p)
        self.music = AudioFeed(self.work / "music.fifo", self.stop_event)
        self.sfx = AudioFeed(self.work / "sfx.fifo", self.stop_event)
        self.music.start()
        self.sfx.start()
        if self.state.get("music_file"):
            self.load_music(Path(self.state["music_file"]), self.state.get("music_playing", False))
        cmd = self.command()
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, start_new_session=True)
        threading.Thread(target=self._read_progress, daemon=True).start()
        threading.Thread(target=self._read_log, daemon=True).start()
        log.info("mixer %s run %s started with %s", self.key[:9], self.run_no, ",".join(self.sources))

    def _read_progress(self) -> None:
        cur: dict = {}
        assert self.proc and self.proc.stdout
        for raw in self.proc.stdout:
            line = raw.decode(errors="ignore").strip()
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            cur[k] = v
            if k == "progress":
                cur["at"] = time.monotonic()
                self.progress = dict(cur)

    def _read_log(self) -> None:
        """Meter readings update the VU meters; everything else (except per-frame noise) goes to the run's log file."""
        assert self.proc and self.proc.stderr
        with open(self.work / f"mixer_{self.run_no:03d}.log", "a", errors="ignore") as logf:
            for raw in self.proc.stderr:
                line = raw.decode(errors="ignore").rstrip()
                if METER in line:
                    hit = parse_meter(line)
                    if hit:
                        self.levels[hit[0]] = hit[1]
                        self.levels[f"{hit[0]}@"] = time.monotonic()
                    continue
                logf.write(line + "\n")
                logf.flush()

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def stop(self) -> None:
        self.stop_event.set()
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        if self._sock is not None:
            self._sock.close(linger=0)
        # Unblock reader/feeder threads still waiting on their FIFOs.
        for name in ("music.fifo", "sfx.fifo"):
            p = self.work / name
            try:
                fd = os.open(p, os.O_RDWR | os.O_NONBLOCK)
                os.close(fd)
            except OSError:
                pass
            p.unlink(missing_ok=True)

    # -- live control --
    def send(self, command: str) -> bool:
        """One command to a running filter, e.g. `streamselect@sel map 1`."""
        if not self.alive():
            return False
        with self._zmq_lock:
            try:
                if self._sock is None:
                    self._sock = zmq.Context.instance().socket(zmq.REQ)
                    self._sock.setsockopt(zmq.RCVTIMEO, 2000)
                    self._sock.setsockopt(zmq.SNDTIMEO, 2000)
                    self._sock.setsockopt(zmq.LINGER, 0)
                    self._sock.connect(f"tcp://127.0.0.1:{self.zmq_port}")
                self._sock.send_string(command)
                reply = self._sock.recv_string()
                return reply.startswith("0")
            except zmq.ZMQError as e:
                log.warning("mixer command %r failed: %s", command, e)
                if self._sock is not None:
                    self._sock.close(linger=0)
                self._sock = None
                return False

    def apply_gains(self) -> None:
        for ch in CHANNELS:
            self.send(f"volume@ch_{ch} volume {self._gain(ch)}")

    def switch(self, source: str, transition: str = "cut") -> bool:
        if source not in self.index:
            return False
        target = self.index[source]
        if transition == "fade":
            for b in np.linspace(0, -1, 7)[1:]:
                self.send(f"eq@fx brightness {b:.2f}")
                time.sleep(0.04)
            ok = self.send(f"streamselect@sel map {target}")
            for b in np.linspace(-1, 0, 7)[1:]:
                self.send(f"eq@fx brightness {b:.2f}")
                time.sleep(0.04)
            return ok
        if transition == "stinger":
            for b in (0.35, 0.7, 1.0):
                self.send(f"eq@fx brightness {b:.2f}")
                time.sleep(0.03)
            ok = self.send(f"streamselect@sel map {target}")
            for b in (0.7, 0.35, 0.0):
                self.send(f"eq@fx brightness {b:.2f}")
                time.sleep(0.05)
            return ok
        return self.send(f"streamselect@sel map {target}")

    def update_overlay(self, chat: list[dict], alert: dict | None, title: str) -> None:
        card = active_card(self.state, self.sources)
        img = render_overlay(self.state, chat, alert, self.w, self.h, card, title)
        tmp = self.work / "overlay.tmp.png"
        img.save(tmp, compress_level=1)
        os.replace(tmp, self.work / "overlay.png")

    def play_effect(self, name: str) -> bool:
        if self.sfx is None or name not in self.effects:
            return False
        self.sfx.play(self.effects[name])
        return True

    def load_music(self, path: Path, playing: bool) -> None:
        if self.music is None:
            return
        if not playing or not path.exists():
            self.music.set_loop(None)
            return
        pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-t", "1800", "-f", "s16le", "-ac", "2", "-ar", str(RATE), "-"],
                             capture_output=True, check=False).stdout
        samples = np.frombuffer(pcm, np.int16).reshape(-1, 2) if pcm else None
        self.music.set_loop(samples)


def active_card(state: dict, sources: dict) -> str | None:
    """The full-screen card the current scene shows (Intro/BRB/Ending), or "camoff" for a camera turned off."""
    scene = next((s for s in state.get("scenes", []) if s.get("name") == state.get("scene")), None)
    if scene and scene.get("card"):
        return scene["card"]
    if state.get("program") in state.get("camera_off", []):
        return "camoff"
    return None


def concat_recordings(work: Path, out: Path) -> bool:
    """Joins the recording pieces (one per mixer run) into one fast-start MP4 for the VOD."""
    parts = sorted(p for p in work.glob("rec_*.ts") if p.stat().st_size > 0)
    if not parts:
        return False
    lst = work / "rec.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in parts))
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", "-bsf:a", "aac_adtstoasc",
                        "-movflags", "+faststart", str(out)], capture_output=True)
    return r.returncode == 0 and out.exists() and out.stat().st_size > 0


def clear_dir(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
