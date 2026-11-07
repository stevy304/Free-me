"""Starts the real platform processes for live tests: S3 stand-in (moto), RTMP server (Node-Media-Server), API (uvicorn).
Separate ports, a separate database and folders, so nothing touches a developer's running services."""

import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
PY = sys.executable


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, timeout: float = 30) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            if httpx.get(url, timeout=1).status_code < 500:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.3)
    raise RuntimeError(f"{url} did not start")


class Platform:
    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="platform-test-"))
        self.ports = {k: free_port() for k in ("api", "rtmp", "stats", "s3")}
        self.api = f"http://127.0.0.1:{self.ports['api']}"
        self.rtmp = f"rtmp://127.0.0.1:{self.ports['rtmp']}/live"
        self.env = {
            **os.environ,
            "DATABASE_URL": os.environ.get("TEST_DATABASE_URL", "postgresql+psycopg://rights:rights@127.0.0.1:5432/rights_test"),
            "STORAGE_BACKEND": "hetzner", "HETZNER_ENDPOINT": f"http://127.0.0.1:{self.ports['s3']}", "HETZNER_ADDRESSING": "path",
            "HETZNER_BUCKET": "videos-test", "HETZNER_ACCESS_KEY": "test", "HETZNER_SECRET_KEY": "test", "HETZNER_REGION": "fsn1",
            "HETZNER_CDN_URL": f"http://127.0.0.1:{self.ports['s3']}", "CDN_STREAM_URL": f"http://127.0.0.1:{self.ports['s3']}/videos-test-stream",
            "CDN_THUMBS_URL": f"http://127.0.0.1:{self.ports['s3']}/videos-test-thumbs", "HETZNER_TMP_DIR": str(self.tmp / "tmp"),
            "RTMP_URL": self.rtmp, "RTMP_INTERNAL_URL": self.rtmp, "RTMP_PORT": str(self.ports["rtmp"]), "RTMP_STATS_PORT": str(self.ports["stats"]),
            "RTMP_STATS_URL": f"http://127.0.0.1:{self.ports['stats']}/stats", "RTMP_HOOK_SECRET": "test-hook-secret", "API_INTERNAL_URL": self.api,
            "HLS_URL": f"{self.api}/hls", "HLS_DIR": str(self.tmp / "hls"), "LIVE_WORK_DIR": str(self.tmp / "live"), "UPLOAD_DIR": str(self.tmp / "uploads"),
            "JWT_SECRET": "test-secret-that-is-long-enough-for-hs256", "CELERY_EAGER": "true", "LIVE_RIGHTS_INTERVAL": "3600",
            "LIVE_RECONNECT_SECONDS": "8", "LIVE_WIDTH": "640", "LIVE_HEIGHT": "360", "LIVE_BITRATE_KBPS": "1200", "PYTHONPATH": str(ROOT),
            "RUNPOD_API_KEY": "", "RUNPOD_ENDPOINT_ID": "",
        }
        self.procs: list[subprocess.Popen] = []

    def spawn(self, args, name, cwd=ROOT):
        log = open(self.tmp / f"{name}.log", "wb")
        p = subprocess.Popen(args, cwd=cwd, env=self.env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.procs.append(p)
        return p

    def start(self):
        moto = shutil.which("moto_server", path=str(Path(PY).parent)) or "moto_server"
        self.spawn([moto, "-H", "127.0.0.1", "-p", str(self.ports["s3"])], "s3")
        wait_http(f"http://127.0.0.1:{self.ports['s3']}/")
        subprocess.run([PY, "-c", "from app.db import Base, engine; import app.models; Base.metadata.drop_all(engine)"], env=self.env, cwd=ROOT, check=True)
        subprocess.run([PY, "-m", "scripts.setup_hetzner"], env=self.env, cwd=ROOT, check=True, capture_output=True)
        self.spawn(["node", "server.js"], "rtmp", cwd=ROOT / "rtmp")
        self.spawn([PY, "-m", "uvicorn", "app.main:app", "--port", str(self.ports["api"])], "api")
        wait_http(f"{self.api}/api/health")
        wait_http(f"http://127.0.0.1:{self.ports['stats']}/stats")
        return self

    def stop(self):
        for p in reversed(self.procs):
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for p in self.procs:
            try:
                p.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def log(self, name: str) -> str:
        return (self.tmp / f"{name}.log").read_text(errors="ignore")


def publish(url: str, pattern: str = "testsrc2", tone: int = 330, seconds: int | None = None, kbps: int = 1500) -> subprocess.Popen:
    """An encoder like OBS: a test picture and a tone, pushed to the RTMP server."""
    args = ["ffmpeg", "-v", "error", "-re", "-f", "lavfi", "-i", f"{pattern}=s=640x360:r=30", "-f", "lavfi", "-i", f"sine=f={tone}:sample_rate=48000"]
    if seconds:
        args += ["-t", str(seconds)]
    args += ["-c:v", "libx264", "-preset", "ultrafast", "-b:v", f"{kbps}k", "-g", "60", "-c:a", "aac", "-f", "flv", url]
    return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)


def receiver(port: int, out: Path) -> subprocess.Popen:
    """A fake YouTube/Twitch ingest: accepts one RTMP stream and writes it to a file."""
    return subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-listen", "1", "-i", f"rtmp://127.0.0.1:{port}/app/key", "-c", "copy", "-f", "flv", str(out)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def kill(p: subprocess.Popen) -> None:
    try:
        os.killpg(p.pid, signal.SIGTERM)
        p.wait(timeout=10)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        pass
