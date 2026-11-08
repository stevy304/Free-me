"""Stream health for the control room: incoming bitrate/FPS/size, dropped frames, CPU, RAM and network.

Bitrate under LIVE_LOW_BITRATE_KBPS (2000) for 10 s in a row turns the badge yellow: "Connection poor".
"""

import time

import psutil

from app.config import get_settings

LOW_FOR = 10.0


class HealthTracker:
    def __init__(self):
        self.low_since: float | None = None
        self._net = psutil.net_io_counters()
        self._net_at = time.monotonic()
        psutil.cpu_percent(None)

    def system(self) -> dict:
        now = time.monotonic()
        net = psutil.net_io_counters()
        dt = max(now - self._net_at, 1e-3)
        out = {
            "cpu_percent": psutil.cpu_percent(None),
            "ram_percent": psutil.virtual_memory().percent,
            "net_in_kbps": round((net.bytes_recv - self._net.bytes_recv) * 8 / 1000 / dt),
            "net_out_kbps": round((net.bytes_sent - self._net.bytes_sent) * 8 / 1000 / dt),
        }
        self._net, self._net_at = net, now
        return out

    def assess(self, main: dict | None, progress: dict, reconnecting_until: float | None) -> dict:
        s = get_settings()
        now = time.monotonic()
        bitrate = int((main or {}).get("bitrate_kbps") or 0)
        if main and bitrate < s.live_low_bitrate_kbps:
            self.low_since = self.low_since or now
        else:
            self.low_since = None
        poor = self.low_since is not None and now - self.low_since >= LOW_FOR
        dropped = int(progress.get("drop_frames") or 0)
        out_fps = float(progress.get("fps") or 0)
        if reconnecting_until:
            label, level = "Reconnecting", "bad"
        elif not main:
            label, level = "Offline", "bad"
        elif poor:
            label, level = "Connection poor", "warn"
        elif out_fps and out_fps < get_settings().live_fps * 0.8:
            label, level = "Encoder overloaded", "warn"
        else:
            label, level = "Excellent", "good"
        return {
            "label": label,
            "level": level,
            "bitrate_kbps": bitrate,
            "fps": (main or {}).get("fps") or 0,
            "resolution": f"{(main or {}).get('width', 0)}x{(main or {}).get('height', 0)}" if main else None,
            "output_fps": out_fps,
            "dropped_frames": dropped,
            "speed": progress.get("speed"),
            "low_bitrate_seconds": round(now - self.low_since, 1) if self.low_since else 0,
            "reconnect_seconds_left": max(0, round(reconnecting_until - now)) if reconnecting_until else None,
            **self.system(),
        }
