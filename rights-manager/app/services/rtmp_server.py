"""Live sessions: what happens between an encoder connecting to the RTMP server and the stream ending.

Node-Media-Server (rtmp/server.js) asks this module about every publish:
  /live/<key>             the creator's main encoder (OBS, Streamlabs, vMix, Larix…) -> stream goes LIVE
  /live/<key>-cam2..cam4  more cameras (another encoder or phone with the same key + suffix)
  /live/<key>-screen      screen share and /live/<key>-guest a guest, both published from the browser by this API
  /live/<key>-program     the mixer's output (only this machine may publish it)

One LiveSession per live stream owns the FFmpeg mixer, the restream processes, the health monitor, the live
Rights Manager check and the reconnect window. It lives in the API process (run the API with one worker on the
machine that runs the RTMP server; see README).
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import httpx
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.models import ChatMessage, Destination, DestinationStatus, LiveStatus, LiveStream, Role, StreamKey, User
from app.services import mixer as mx
from app.services.stream_health import HealthTracker
from app.services.transcoder import destination_url, restream_command

log = logging.getLogger(__name__)
INTERNAL = {"program"}


def parse_path(stream_path: str) -> tuple[str, str] | None:
    """'/live/live_ab12_..-cam2' -> ('live_ab12_..', 'cam2'); None when the path is not ours."""
    parts = stream_path.strip("/").split("/")
    if len(parts) != 2 or parts[0] != "live" or not parts[1]:
        return None
    name = parts[1]
    if name.endswith("-program"):
        return name[: -len("-program")], "program"
    for source, suffix in mx.SUFFIX.items():
        if suffix and name.endswith(suffix):
            return name[: -len(suffix)], source
    return name, "cam1"


async def nms_stats() -> dict:
    try:
        async with httpx.AsyncClient(timeout=2) as c:
            r = await c.get(get_settings().rtmp_stats_url)
            return r.json() if r.status_code == 200 else {}
    except (httpx.HTTPError, ValueError):
        return {}


@dataclass
class Restream:
    dest_id: int
    url: str
    proc: asyncio.subprocess.Process | None = None
    status: str = "Disconnected"
    error: str | None = None
    tries: int = 0
    task: asyncio.Task | None = None
    stopping: bool = False


@dataclass
class LiveSession:
    stream_id: int
    creator_id: int
    key: str
    playback_id: str
    title: str
    work: Path
    hls: Path
    sources: dict[str, mx.Source] = field(default_factory=dict)
    mixer: mx.Mixer | None = None
    run_no: int = 0
    program_live: bool = False
    restreams: dict[int, Restream] = field(default_factory=dict)
    reconnecting_until: float | None = None
    health: dict = field(default_factory=dict)
    tracker: HealthTracker = field(default_factory=HealthTracker)
    chat: list[dict] = field(default_factory=list)
    alert: dict | None = None
    rights: dict | None = None
    tasks: list[asyncio.Task] = field(default_factory=list)
    restart_task: asyncio.Task | None = None
    reconnect_task: asyncio.Task | None = None
    ending: bool = False
    state: dict = field(default_factory=dict)
    mixer_failures: int = 0


class LiveSupervisor:
    def __init__(self):
        self.sessions: dict[int, LiveSession] = {}
        self.by_key: dict[str, int] = {}
        self.lock = asyncio.Lock()
        self.effects = mx.synth_effects()
        # Keys whose stream was just ended: OBS reconnecting by itself must not start a new stream at once.
        self.ended_recently: dict[str, float] = {}

    async def recover(self) -> None:
        """After an API restart: streams still marked Live get their session back if the encoder is still connected
        (it re-announces itself by reconnecting), otherwise they end."""
        stats = await nms_stats()
        live = await asyncio.to_thread(_live_streams)
        for s in live:
            paths = [p for p in stats if (parse_path(p) or ("", ""))[0] == s["key"]]
            if not any(parse_path(p)[1] == "cam1" for p in paths):
                await self.end(s["id"], reason="not connected after restart")
                continue
            # The encoder never noticed the restart: pick the stream up again, main input first.
            for p in sorted(paths, key=lambda p: parse_path(p)[1] != "cam1"):
                if parse_path(p)[1] != "program":
                    await self.on_publish(p, local=True)
            log.info("stream %s resumed after restart", s["id"])

    async def shutdown(self) -> None:
        """Stops this process's FFmpeg work but leaves streams live: the next start resumes them (deploys don't end streams)."""
        for sess in list(self.sessions.values()):
            sess.ending = True
            for t in sess.tasks + [sess.restart_task, sess.reconnect_task]:
                if t:
                    t.cancel()
            if sess.mixer:
                await asyncio.to_thread(sess.mixer.stop)
            for r in sess.restreams.values():
                r.stopping = True
                if r.proc and r.proc.returncode is None:
                    r.proc.terminate()
        self.sessions.clear()
        self.by_key.clear()

    # ---- RTMP hooks --------------------------------------------------------------------------------------------------
    async def on_publish(self, stream_path: str, local: bool) -> dict:
        parsed = parse_path(stream_path)
        if not parsed:
            return {"allow": False, "reason": "unknown application"}
        key, source = parsed
        async with self.lock:
            if source == "program":
                sid = self.by_key.get(key)
                if not local or sid is None:
                    return {"allow": False, "reason": "program feed is internal"}
                sess = self.sessions[sid]
                sess.program_live = True
                asyncio.create_task(self.start_restreams(sess))
                return {"allow": True}
            found = await asyncio.to_thread(_find_key, key)
            # After END STREAM, OBS keeps reconnecting by itself; that must not start a new stream unless the creator
            # set one up (GO LIVE on a new stream).
            if found and source == "cam1" and time.monotonic() - self.ended_recently.get(key, -1e9) < 60 and not found["armed"]:
                return {"allow": False, "reason": "this stream just ended; press GO LIVE on a new stream first"}
            if not found:
                return {"allow": False, "reason": "invalid or disabled stream key"}
            if source in ("screen", "guest") and not local:
                return {"allow": False, "reason": "screen share and guests join through the browser"}
            if source == "cam1":
                stream = await asyncio.to_thread(_go_live, found)
                sess = self.sessions.get(stream["id"])
                if sess is None:
                    sess = self._new_session(stream, key)
                if sess.reconnect_task:
                    sess.reconnect_task.cancel()
                    sess.reconnect_task = None
                sess.reconnecting_until = None
                sess.sources["cam1"] = mx.Source("cam1")
                self._schedule_restart(sess, delay=1.0)
                return {"allow": True, "stream_id": stream["id"]}
            sid = self.by_key.get(key)
            if sid is None:
                return {"allow": False, "reason": "start the main stream first"}
            sess = self.sessions[sid]
            if source.startswith("cam") and sum(1 for s in sess.sources if s.startswith("cam")) >= 4 and source not in sess.sources:
                return {"allow": False, "reason": "up to 4 cameras"}
            sess.sources[source] = mx.Source(source)
            self._schedule_restart(sess, delay=1.5)
            return {"allow": True, "stream_id": sid}

    async def on_done(self, stream_path: str) -> None:
        parsed = parse_path(stream_path)
        if not parsed:
            return
        key, source = parsed
        async with self.lock:
            sid = self.by_key.get(key)
            if sid is None:
                return
            sess = self.sessions[sid]
            if source == "program":
                sess.program_live = False
                return
            if source == "cam1":
                # OBS dropped: keep the stream for LIVE_RECONNECT_SECONDS before ending it.
                sess.sources.pop("cam1", None)
                self._stop_mixer(sess)
                wait = get_settings().live_reconnect_seconds
                sess.reconnecting_until = time.monotonic() + wait
                sess.reconnect_task = asyncio.create_task(self._end_if_not_back(sess, wait))
                return
            if sess.sources.pop(source, None) is not None:
                if sess.state.get("program") == source:
                    sess.state["program"] = "cam1"
                self._schedule_restart(sess, delay=1.0)

    async def _end_if_not_back(self, sess: LiveSession, wait: float) -> None:
        await asyncio.sleep(wait)
        if "cam1" not in sess.sources and not sess.ending:
            log.info("stream %s did not reconnect within %ss: ending", sess.stream_id, wait)
            await self.end(sess.stream_id, reason="disconnected")

    # ---- session lifecycle -------------------------------------------------------------------------------------------
    def _new_session(self, stream: dict, key: str) -> LiveSession:
        s = get_settings()
        work = s.live_work_dir / str(stream["id"])
        hls = s.hls_dir / stream["playback_id"]
        state = mx.default_state()
        state.update(stream.get("studio_state") or {})
        sess = LiveSession(stream["id"], stream["creator_id"], key, stream["playback_id"], stream["title"], work, hls, state=state)
        sess.chat = stream.get("chat", [])
        # Continue numbering after a restart, so earlier recording pieces (and HLS segments) are never overwritten.
        existing = [int(p.stem.split("_")[1]) for p in work.glob("rec_*.ts") if p.stem.split("_")[1].isdigit()]
        sess.run_no = max(existing, default=0)
        self.sessions[sess.stream_id] = sess
        self.by_key[key] = sess.stream_id
        sess.tasks.append(asyncio.create_task(self._health_loop(sess)))
        sess.tasks.append(asyncio.create_task(self._rights_loop(sess)))
        return sess

    def _schedule_restart(self, sess: LiveSession, delay: float) -> None:
        """(Re)starts the mixer shortly after the set of inputs changes (several changes at once restart it once)."""
        if sess.restart_task and not sess.restart_task.done():
            sess.restart_task.cancel()
        sess.restart_task = asyncio.create_task(self._restart_mixer(sess, delay))

    async def _restart_mixer(self, sess: LiveSession, delay: float) -> None:
        await asyncio.sleep(delay)
        if "cam1" not in sess.sources or sess.ending:
            return
        # Wait until the encoders have sent their stream headers, to know which have sound and picture.
        for _ in range(20):
            stats = await nms_stats()
            ready = True
            for name, src in sess.sources.items():
                st = stats.get(f"/live/{sess.key}{mx.SUFFIX[name]}")
                if not st or not (st.get("has_video") or st.get("has_audio")):
                    ready = False
                    continue
                src.has_video, src.has_audio = bool(st.get("has_video")), bool(st.get("has_audio"))
                src.width, src.height, src.fps = st.get("width", 0), st.get("height", 0), st.get("fps", 0)
            if ready:
                break
            await asyncio.sleep(0.5)
        sess.sources = {n: s for n, s in sess.sources.items() if s.has_video or s.has_audio}
        if not sess.sources.get("cam1"):
            return
        self._stop_mixer(sess)
        sess.run_no += 1
        m = mx.Mixer(sess.key, sess.playback_id, dict(sess.sources), sess.work, sess.hls, sess.run_no, sess.state)
        try:
            await asyncio.to_thread(m.start, self.effects, sess.chat, sess.title)
        except Exception:
            log.exception("mixer start failed for stream %s", sess.stream_id)
            return
        sess.mixer = m

    def _stop_mixer(self, sess: LiveSession) -> None:
        if sess.mixer:
            m, sess.mixer = sess.mixer, None
            asyncio.get_running_loop().run_in_executor(None, m.stop)

    async def end(self, stream_id: int, reason: str = "ended") -> dict | None:
        sess = self.sessions.get(stream_id)
        if sess is None:
            return await asyncio.to_thread(_mark_ended, stream_id, None)
        sess.ending = True
        for t in sess.tasks + [sess.restart_task, sess.reconnect_task]:
            if t and t is not asyncio.current_task():
                t.cancel()
        if sess.mixer:
            m, sess.mixer = sess.mixer, None
            await asyncio.to_thread(m.stop)
        await self.stop_restreams(sess)
        if reason == "ended by creator":
            self.ended_recently[sess.key] = time.monotonic()
        await _kick_publishers(sess.key)
        self.sessions.pop(stream_id, None)
        self.by_key.pop(sess.key, None)
        result = await asyncio.to_thread(_mark_ended, stream_id, sess.health)
        # The recording becomes a VOD on Hetzner, processed like an upload.
        asyncio.get_running_loop().run_in_executor(None, _save_vod, stream_id, sess.work, sess.hls)
        log.info("stream %s ended (%s)", stream_id, reason)
        return result

    # ---- restreaming -------------------------------------------------------------------------------------------------
    async def start_restreams(self, sess: LiveSession) -> None:
        dests = await asyncio.to_thread(_enabled_destinations, sess.stream_id)
        for d in dests:
            r = sess.restreams.get(d["id"])
            if r and r.proc and r.proc.returncode is None:
                continue
            r = Restream(d["id"], destination_url(d["rtmp_url"], d["stream_key"]))
            sess.restreams[d["id"]] = r
            r.task = asyncio.create_task(self._run_restream(sess, r))

    async def _run_restream(self, sess: LiveSession, r: Restream) -> None:
        while not r.stopping and not sess.ending and r.tries < 6:
            await asyncio.sleep(0 if r.tries == 0 else min(30, 2 ** r.tries))
            if not sess.program_live:
                await asyncio.sleep(1)
                continue
            r.tries += 1
            r.proc = await asyncio.create_subprocess_exec(*restream_command(sess.key, r.url), stdout=asyncio.subprocess.DEVNULL,
                                                          stderr=asyncio.subprocess.PIPE, stdin=asyncio.subprocess.DEVNULL)
            started = time.monotonic()
            connected = asyncio.create_task(self._mark_connected(sess, r))
            err = (await r.proc.stderr.read()).decode(errors="ignore").strip() if r.proc.stderr else ""
            await r.proc.wait()
            connected.cancel()
            if r.stopping or sess.ending:
                break
            if time.monotonic() - started > 30:
                r.tries = 0  # it worked for a while: a fresh run of retries
            r.status, r.error = "Error", (err.splitlines()[-1] if err else f"exited with code {r.proc.returncode}")[:300]
            await asyncio.to_thread(_set_destination, r.dest_id, DestinationStatus.Error, r.error)
        if r.status != "Error" or r.stopping or sess.ending:
            r.status = "Disconnected"
            await asyncio.to_thread(_set_destination, r.dest_id, DestinationStatus.Disconnected, None)

    async def _mark_connected(self, sess: LiveSession, r: Restream) -> None:
        await asyncio.sleep(4)
        if r.proc and r.proc.returncode is None:
            r.status, r.error = "Connected", None
            await asyncio.to_thread(_set_destination, r.dest_id, DestinationStatus.Connected, None)

    async def stop_restreams(self, sess: LiveSession, dest_id: int | None = None) -> None:
        for did, r in list(sess.restreams.items()):
            if dest_id is not None and did != dest_id:
                continue
            r.stopping = True
            if r.proc and r.proc.returncode is None:
                r.proc.terminate()
            if r.task:
                try:
                    await asyncio.wait_for(r.task, 10)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    pass
            sess.restreams.pop(did, None)
            await asyncio.to_thread(_set_destination, did, DestinationStatus.Disconnected, None)

    # ---- monitoring --------------------------------------------------------------------------------------------------
    async def _health_loop(self, sess: LiveSession) -> None:
        from app.redis_client import get_redis

        peak_saved = 0
        while not sess.ending:
            stats = await nms_stats()
            main = stats.get(f"/live/{sess.key}")
            m = sess.mixer
            sess.health = sess.tracker.assess(main, m.progress if m else {}, sess.reconnecting_until)
            sess.health["encoder"] = get_settings().live_encoder
            sess.health["recording"] = bool(m and m.alive())
            sess.health["inputs"] = {n: stats.get(f"/live/{sess.key}{mx.SUFFIX[n]}") for n in sess.sources}
            try:
                r = get_redis()
                key = f"live:viewers:{sess.stream_id}"
                r.zremrangebyscore(key, 0, time.time() - 30)
                viewers = r.zcard(key)
            except Exception:
                viewers = 0
            sess.health["viewers"] = viewers
            if viewers > peak_saved:
                peak_saved = viewers
                await asyncio.to_thread(_save_peak, sess.stream_id, viewers)
            # The mixer died while the main encoder is still connected: start it again.
            if m and not m.alive() and "cam1" in sess.sources and not (sess.restart_task and not sess.restart_task.done()):
                sess.mixer_failures += 1
                delay = min(30.0, 2.0 ** sess.mixer_failures)
                log.warning("mixer for stream %s stopped (code %s); restarting in %ss", sess.stream_id, m.proc.returncode if m.proc else None, delay)
                self._schedule_restart(sess, delay=delay)
            elif m and m.alive() and m.progress.get("progress") == "continue":
                sess.mixer_failures = 0
            if sess.alert and sess.alert["until"] < time.time():
                sess.alert = None
                self.refresh_overlay(sess)
            await asyncio.sleep(2)

    async def _rights_loop(self, sess: LiveSession) -> None:
        interval = get_settings().live_rights_interval
        await asyncio.sleep(min(20, interval))
        while not sess.ending:
            if sess.mixer and sess.mixer.alive():
                try:
                    from app.workers.live_tasks import check_live_clip

                    sess.rights = await asyncio.to_thread(check_live_clip, sess.stream_id, str(sess.hls), sess.creator_id)
                except Exception:
                    log.exception("live rights check failed for %s", sess.stream_id)
            await asyncio.sleep(interval)

    # ---- control room ------------------------------------------------------------------------------------------------
    def refresh_overlay(self, sess: LiveSession) -> None:
        if sess.mixer:
            sess.mixer.state = sess.state
            sess.mixer.update_overlay(sess.chat, sess.alert, sess.title)


SUPERVISOR = LiveSupervisor()


# ---- database helpers (run in a thread) ------------------------------------------------------------------------------

def _find_key(key: str) -> dict | None:
    with SessionLocal() as db:
        k = db.scalar(select(StreamKey).where(StreamKey.key_value == key, StreamKey.is_active.is_(True)))
        if k is None:
            return None
        user = db.get(User, k.creator_id)
        if user is None or user.role == Role.viewer:
            return None
        armed = db.scalar(select(LiveStream.id).where(LiveStream.creator_id == k.creator_id, LiveStream.armed.is_(True),
                                                       LiveStream.status != LiveStatus.Ended)) is not None
        return {"id": k.id, "creator_id": k.creator_id, "armed": armed}


def _go_live(found: dict) -> dict:
    """The creator's upcoming (or reconnecting) stream goes live; one is made if they had none."""
    with SessionLocal() as db:
        now = datetime.now(UTC)
        stream = db.scalar(
            select(LiveStream).where(LiveStream.creator_id == found["creator_id"], LiveStream.status != LiveStatus.Ended)
            .order_by(LiveStream.status.desc(), LiveStream.armed.desc(), LiveStream.created_at.desc())
        )
        if stream is None:
            stream = LiveStream(creator_id=found["creator_id"], title="Live stream", status=LiveStatus.Scheduled)
            db.add(stream)
        if stream.status != LiveStatus.Live:
            stream.status, stream.started_at = LiveStatus.Live, now
        stream.stream_key_id, stream.armed = found["id"], False
        key = db.get(StreamKey, found["id"])
        key.last_used_at = now
        db.commit()
        chat = [{"username": m.username, "text": m.text} for m in db.scalars(
            select(ChatMessage).where(ChatMessage.stream_id == stream.id, ChatMessage.hidden.is_(False)).order_by(ChatMessage.id.desc()).limit(6))][::-1]
        return {"id": stream.id, "creator_id": stream.creator_id, "playback_id": stream.playback_id, "title": stream.title,
                "studio_state": stream.studio_state, "chat": chat}


def _live_streams() -> list[dict]:
    with SessionLocal() as db:
        rows = db.execute(select(LiveStream.id, StreamKey.key_value).join(StreamKey, StreamKey.id == LiveStream.stream_key_id, isouter=True)
                          .where(LiveStream.status == LiveStatus.Live)).all()
        return [{"id": r[0], "key": r[1]} for r in rows]


def _mark_ended(stream_id: int, health: dict | None) -> dict | None:
    with SessionLocal() as db:
        stream = db.get(LiveStream, stream_id)
        if stream is None:
            return None
        if stream.status == LiveStatus.Live:
            stream.status, stream.ended_at = LiveStatus.Ended, datetime.now(UTC)
        elif stream.status == LiveStatus.Scheduled:
            stream.status, stream.ended_at = LiveStatus.Ended, datetime.now(UTC)
        stream.armed = False
        db.commit()
        return {"id": stream.id, "status": stream.status.value}


def _enabled_destinations(stream_id: int) -> list[dict]:
    with SessionLocal() as db:
        return [{"id": d.id, "rtmp_url": d.rtmp_url, "stream_key": d.stream_key}
                for d in db.scalars(select(Destination).where(Destination.stream_id == stream_id, Destination.is_enabled.is_(True)))]


def _set_destination(dest_id: int, status: DestinationStatus, error: str | None) -> None:
    with SessionLocal() as db:
        d = db.get(Destination, dest_id)
        if d:
            d.status, d.last_error = status, error
            db.commit()


def _save_peak(stream_id: int, viewers: int) -> None:
    with SessionLocal() as db:
        s = db.get(LiveStream, stream_id)
        if s and viewers > (s.viewer_peak or 0):
            s.viewer_peak = viewers
            db.commit()


def _save_vod(stream_id: int, work: Path, hls: Path) -> None:
    try:
        from app.workers.live_tasks import save_vod

        save_vod(stream_id, str(work))
    except Exception:
        log.exception("saving the VOD of stream %s failed", stream_id)
    finally:
        shutil.rmtree(hls, ignore_errors=True)


async def _kick_publishers(key: str) -> None:
    """Ending from the control room also disconnects the encoders (OBS shows "disconnected")."""
    stats = await nms_stats()
    for path in stats:
        parsed = parse_path(path)
        if parsed and parsed[0] == key:
            try:
                async with httpx.AsyncClient(timeout=2) as c:
                    await c.post(get_settings().rtmp_stats_url.replace("/stats", "/kick"), json={"stream_path": path})
            except httpx.HTTPError:
                pass
