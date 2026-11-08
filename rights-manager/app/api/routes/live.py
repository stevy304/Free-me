"""Live streams: setup and scheduling, the control room (scenes, cameras, mixer, overlays, effects), chat with
moderation, viewers, guests and screen share joining from the browser, and ending."""

import asyncio
import re
import secrets
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.live_common import own_stream, require_creator, stream_out, visible_stream
from app.config import get_settings
from app.db import get_db
from app.models import ChatBan, ChatMessage, Destination, LivePrivacy, LiveStatus, LiveStream, Role, User, Video
from app.redis_client import get_redis
from app.security import bearer, get_current_user
from app.services import cdn_manager, mixer as mx, storage_manager
from app.services.rtmp_server import SUPERVISOR

router = APIRouter(prefix="/api/live", tags=["live"])
CATEGORIES = ("Gaming", "Music", "Education", "Sports", "News", "Talk", "Technology", "Entertainment", "Other")


def optional_user(creds=Depends(bearer), db: Session = Depends(get_db)) -> User | None:
    if creds is None:
        return None
    try:
        return get_current_user(creds, db)
    except HTTPException:
        return None


# ---- setup -----------------------------------------------------------------------------------------------------------

class StreamIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    category: str | None = Field(None, max_length=60)
    description: str | None = Field(None, max_length=5000)
    privacy: LivePrivacy = LivePrivacy.Public
    scheduled_for: datetime | None = None


class StreamPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    category: str | None = Field(None, max_length=60)
    description: str | None = Field(None, max_length=5000)
    privacy: LivePrivacy | None = None
    scheduled_for: datetime | None = None


@router.get("/categories")
def categories() -> list[str]:
    return list(CATEGORIES)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_stream(body: StreamIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Step 1 of Go Live (or Schedule): title, category, description, privacy, optional start time."""
    require_creator(user)
    if body.scheduled_for and body.scheduled_for < datetime.now(UTC) - timedelta(minutes=1):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The scheduled time is in the past.")
    s = LiveStream(creator_id=user.id, title=body.title.strip(), category=body.category, description=body.description, privacy=body.privacy,
                   status=LiveStatus.Scheduled, scheduled_for=body.scheduled_for, studio_state=mx.default_state(), blocked_words=[])
    db.add(s)
    db.commit()
    return stream_out(s)


@router.get("")
def my_streams(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[dict]:
    """Upcoming, live and past streams, with the saved VOD's views and length."""
    q = select(LiveStream).order_by(LiveStream.created_at.desc()).limit(100)
    if user.role != Role.admin:
        q = q.where(LiveStream.creator_id == user.id)
    out = []
    for s in db.scalars(q):
        vod = db.get(Video, s.vod_video_id) if s.vod_video_id else None
        out.append(stream_out(s, {"vod": {"id": vod.id, "status": vod.status.value, "views": vod.view_count, "duration": vod.duration} if vod else None}))
    return out


@router.get("/now")
def live_now(db: Session = Depends(get_db)) -> list[dict]:
    """Public streams that are live right now."""
    q = select(LiveStream).where(LiveStream.status == LiveStatus.Live, LiveStream.privacy == LivePrivacy.Public).order_by(LiveStream.started_at.desc())
    return [stream_out(s, {"viewers": (SUPERVISOR.sessions.get(s.id).health.get("viewers") if s.id in SUPERVISOR.sessions else 0)}) for s in db.scalars(q)]


@router.get("/{stream_id}")
def get_stream(stream_id: int, user: User | None = Depends(optional_user), db: Session = Depends(get_db)) -> dict:
    s = visible_stream(db, stream_id, user)
    sess = SUPERVISOR.sessions.get(s.id)
    return stream_out(s, {"viewers": sess.health.get("viewers", 0) if sess else 0, "on_air": bool(sess and sess.mixer and sess.mixer.alive()),
                          "slow_mode_seconds": s.slow_mode_seconds})


@router.patch("/{stream_id}")
def update_stream(stream_id: int, body: StreamPatch, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Title, category, privacy… can change while live."""
    s = own_stream(db, stream_id, user)
    for field in ("title", "category", "description", "privacy", "scheduled_for"):
        v = getattr(body, field)
        if v is not None:
            setattr(s, field, v.strip() if isinstance(v, str) else v)
    db.commit()
    sess = SUPERVISOR.sessions.get(s.id)
    if sess and body.title:
        sess.title = s.title
        SUPERVISOR.refresh_overlay(sess)
    return stream_out(s)


@router.post("/{stream_id}/thumbnail")
def set_thumbnail(stream_id: int, file: UploadFile = File(...), user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    s = own_stream(db, stream_id, user)
    data = file.file.read(5 * 1024 * 1024 + 1)
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Thumbnails can be at most 5 MB.")
    from io import BytesIO

    from PIL import Image, UnidentifiedImageError

    try:
        img = Image.open(BytesIO(data)).convert("RGB")
    except UnidentifiedImageError:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Use a JPEG, PNG or WebP image.") from None
    img.thumbnail((1280, 720))
    out = BytesIO()
    img.save(out, "WEBP", quality=82)
    key = f"thumbnails/live/{s.id}-{secrets.token_hex(4)}.webp"
    storage_manager.backend().put_bytes(out.getvalue(), "thumbs", key)
    s.thumbnail_url = cdn_manager.public_url("thumbs", key)
    db.commit()
    return stream_out(s)


@router.post("/{stream_id}/go-live")
def go_live(stream_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Step 4: the stream waits for the encoder ("Waiting for OBS…") and goes LIVE when it connects."""
    s = own_stream(db, stream_id, user)
    if s.status == LiveStatus.Ended:
        raise HTTPException(status.HTTP_409_CONFLICT, "This stream has ended. Create a new one.")
    for other in db.scalars(select(LiveStream).where(LiveStream.creator_id == s.creator_id, LiveStream.armed.is_(True), LiveStream.id != s.id)):
        other.armed = False
    s.armed = True
    db.commit()
    return stream_out(s)


@router.post("/{stream_id}/end")
async def end_stream(stream_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    s = own_stream(db, stream_id, user)
    if s.status == LiveStatus.Ended:
        return stream_out(s)
    await SUPERVISOR.end(stream_id, reason="ended by creator")
    db.refresh(s)
    return stream_out(s)


# ---- control room ----------------------------------------------------------------------------------------------------

def _session(stream_id: int):
    sess = SUPERVISOR.sessions.get(stream_id)
    if sess is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "The stream is not live. Start your encoder first.")
    return sess


def _save_state(db: Session, s: LiveStream, state: dict) -> None:
    s.studio_state = {k: v for k, v in state.items() if k != "music_file"} | ({"music_file": state["music_file"]} if state.get("music_file") else {})
    db.commit()


def _state_for(db: Session, s: LiveStream) -> tuple[dict, object | None]:
    sess = SUPERVISOR.sessions.get(s.id)
    if sess:
        return sess.state, sess
    state = mx.default_state()
    state.update(s.studio_state or {})
    return state, None


@router.get("/{stream_id}/studio")
def studio(stream_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Everything the control room shows, polled about once a second."""
    s = own_stream(db, stream_id, user)
    state, sess = _state_for(db, s)
    m = sess.mixer if sess else None
    levels = {}
    if m:
        now = time.monotonic()
        levels = {c: (m.levels.get(c, -90.0) if now - m.levels.get(f"{c}@", 0) < 2 else -90.0) for c in mx.CHANNELS}
    sources = []
    present = sess.sources if sess else {}
    for name in mx.SOURCES:
        info = (sess.health.get("inputs") or {}).get(name) if sess else None
        sources.append({
            "name": name, "connected": name in present,
            "status": "LIVE" if state.get("program") == name and name in present else ("READY" if name in present else "OFFLINE"),
            "resolution": f"{info.get('height')}p{round(info.get('fps') or 0)}" if info and info.get("height") else None,
            "has_audio": bool(info and info.get("has_audio")), "snapshot": f"/api/live/{s.id}/snapshots/{name}.jpg" if name in present else None,
            "path_suffix": mx.SUFFIX[name],
        })
    if m and m.interview_pair():
        sources.append({"name": "interview", "connected": True, "status": "LIVE" if state.get("program") == "interview" else "READY",
                        "resolution": None, "has_audio": False, "snapshot": None, "path_suffix": None})
    dests = [{"id": d.id, "platform": d.platform.value, "is_enabled": d.is_enabled,
              "status": (sess.restreams[d.id].status if sess and d.id in sess.restreams else d.status.value),
              "error": (sess.restreams[d.id].error if sess and d.id in sess.restreams else d.last_error)}
             for d in db.scalars(select(Destination).where(Destination.stream_id == s.id).order_by(Destination.id))]
    comments = db.scalar(select(ChatMessage.id).where(ChatMessage.stream_id == s.id).order_by(ChatMessage.id.desc()).limit(1))
    return {
        "stream": stream_out(s),
        "on_air": bool(m and m.alive()),
        "waiting_for_encoder": s.armed and s.status != LiveStatus.Live,
        "state": {k: v for k, v in state.items() if k != "music_file"} | {"has_music": bool(state.get("music_file"))},
        "sources": sources,
        "levels": levels,
        "health": sess.health if sess else {"label": "Offline", "level": "bad"},
        "destinations": dests,
        "effects": list(SUPERVISOR.effects),
        "rights": {"last_check": sess.rights if sess else None, "flagged": s.rights_flagged_at is not None, "score": s.rights_score,
                   "admin_muted": s.audio_muted_by_admin},
        "dashboard": {"viewers": (sess.health.get("viewers", 0) if sess else 0), "peak": s.viewer_peak, "likes": s.likes,
                      "comments": db.query(ChatMessage).filter(ChatMessage.stream_id == s.id).count() if comments else 0},
        "moderation": {"slow_mode_seconds": s.slow_mode_seconds, "blocked_words": s.blocked_words or [], "auto_moderate": s.auto_moderate},
        "channels": [{"id": c, "label": mx.CHANNEL_LABEL[c]} for c in mx.CHANNELS],
    }


@router.get("/{stream_id}/snapshots/{name}.jpg")
def snapshot(stream_id: int, name: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> FileResponse:
    own_stream(db, stream_id, user)
    if name not in mx.SOURCES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such source.")
    p = get_settings().live_work_dir / str(stream_id) / "snaps" / f"{name}.jpg"
    if not p.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No picture yet.")
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


class ProgramIn(BaseModel):
    source: str
    transition: str = Field("cut", pattern="^(cut|fade|stinger)$")


@router.post("/{stream_id}/studio/program")
async def set_program(stream_id: int, body: ProgramIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Brings a camera (or the interview layout) to Program with a Cut, Fade or Stinger."""
    s = own_stream(db, stream_id, user)
    sess = _session(stream_id)
    if not sess.mixer or body.source not in sess.mixer.index:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{body.source} is not connected.")
    ok = await asyncio.to_thread(sess.mixer.switch, body.source, body.transition)
    if not ok:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The mixer did not answer. Try again.")
    sess.state["program"], sess.state["transition"] = body.source, body.transition
    # A camera switch leaves card scenes (BRB etc.) and goes back to the main look.
    scene = next((x for x in sess.state["scenes"] if x.get("name") == sess.state.get("scene")), None)
    if scene and scene.get("card"):
        sess.state["scene"], sess.state["scene_mutes"] = "Main", []
        await asyncio.to_thread(sess.mixer.apply_gains)
    await asyncio.to_thread(SUPERVISOR.refresh_overlay, sess)
    _save_state(db, s, sess.state)
    return {"program": body.source}


class TransitionIn(BaseModel):
    transition: str = Field(pattern="^(cut|fade|stinger)$")


@router.post("/{stream_id}/studio/transition")
def set_transition(stream_id: int, body: TransitionIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """The transition used by the next camera or scene switch."""
    s = own_stream(db, stream_id, user)
    state, _ = _state_for(db, s)
    state["transition"] = body.transition
    _save_state(db, s, state)
    return {"transition": body.transition}


class SceneIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)


@router.post("/{stream_id}/studio/scene")
async def set_scene(stream_id: int, body: SceneIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Intro / Main / Interview / BRB (BRB card + microphones muted) / Ending, or a scene the creator added."""
    s = own_stream(db, stream_id, user)
    state, sess = _state_for(db, s)
    scene = next((x for x in state["scenes"] if x["name"] == body.name), None)
    if scene is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such scene.")
    state["scene"] = scene["name"]
    state["scene_mutes"] = list(scene.get("mute", []))
    target = scene.get("source")
    if sess and sess.mixer:
        if target and target in sess.mixer.index:
            await asyncio.to_thread(sess.mixer.switch, target, state.get("transition", "fade"))
            state["program"] = target
        await asyncio.to_thread(sess.mixer.apply_gains)
        await asyncio.to_thread(SUPERVISOR.refresh_overlay, sess)
    elif target:
        state["program"] = target
    _save_state(db, s, state)
    return {"scene": scene["name"], "muted": state["scene_mutes"]}


class NewSceneIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    source: str | None = None
    card_title: str | None = Field(None, max_length=60)
    mute: list[str] = []


@router.post("/{stream_id}/studio/scenes", status_code=status.HTTP_201_CREATED)
def add_scene(stream_id: int, body: NewSceneIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    s = own_stream(db, stream_id, user)
    state, sess = _state_for(db, s)
    if any(x["name"].lower() == body.name.strip().lower() for x in state["scenes"]):
        raise HTTPException(status.HTTP_409_CONFLICT, "A scene with that name exists.")
    scene: dict = {"name": body.name.strip(), "mute": [m for m in body.mute if m in mx.CHANNELS]}
    if body.card_title:
        card_id = f"custom_{len(state['scenes'])}"
        state["cards"][card_id] = {"title": body.card_title, "subtitle": ""}
        scene["card"] = card_id
    else:
        scene["source"] = body.source if body.source in (*mx.SOURCES, "interview") else "cam1"
    state["scenes"].append(scene)
    _save_state(db, s, state)
    return scene


class MixerIn(BaseModel):
    channel: str
    volume: float | None = Field(None, ge=0, le=2)
    muted: bool | None = None


@router.post("/{stream_id}/studio/mixer")
async def set_mixer(stream_id: int, body: MixerIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Moves a fader or mutes a channel; applied to the live program at once."""
    s = own_stream(db, stream_id, user)
    if body.channel not in mx.CHANNELS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such channel.")
    if s.audio_muted_by_admin and body.channel == "master" and body.muted is False and user.role != Role.admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "An administrator muted this stream's sound because of a copyright match.")
    state, sess = _state_for(db, s)
    ch = state["mixer"].setdefault(body.channel, {"volume": 1.0, "muted": False})
    if body.volume is not None:
        ch["volume"] = round(body.volume, 3)
    if body.muted is not None:
        ch["muted"] = body.muted
    if body.channel in state.get("scene_mutes", []) and body.muted is False:
        state["scene_mutes"].remove(body.channel)
    if sess and sess.mixer:
        sess.mixer.state = state
        await asyncio.to_thread(sess.mixer.send, f"volume@ch_{body.channel} volume {sess.mixer._gain(body.channel)}")
    _save_state(db, s, state)
    return {"channel": body.channel, **ch}


class OverlayIn(BaseModel):
    lower_third: dict | None = None
    chat_box: bool | None = None
    alerts: bool | None = None
    camera_off: list[str] | None = None
    cards: dict | None = None


@router.post("/{stream_id}/studio/overlay")
async def set_overlay(stream_id: int, body: OverlayIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Lower third, chat box on screen, alerts, camera off, card texts — redrawn on the program within 0.2 s."""
    s = own_stream(db, stream_id, user)
    state, sess = _state_for(db, s)
    if body.lower_third is not None:
        lt = state.setdefault("lower_third", {})
        for k in ("enabled", "name", "title"):
            if k in body.lower_third:
                lt[k] = body.lower_third[k] if k == "enabled" else str(body.lower_third[k])[:60]
    if body.chat_box is not None:
        state["chat_box"] = body.chat_box
    if body.alerts is not None:
        state["alerts"] = body.alerts
    if body.camera_off is not None:
        state["camera_off"] = [c for c in body.camera_off if c in mx.SOURCES]
    if body.cards:
        for k, v in body.cards.items():
            if k in state["cards"] and isinstance(v, dict):
                state["cards"][k].update({kk: str(vv)[:80] for kk, vv in v.items() if kk in ("title", "subtitle")})
    if sess:
        await asyncio.to_thread(SUPERVISOR.refresh_overlay, sess)
    _save_state(db, s, state)
    return {k: state[k] for k in ("lower_third", "chat_box", "alerts", "camera_off")}


class EffectIn(BaseModel):
    name: str


@router.post("/{stream_id}/studio/sfx")
def play_effect(stream_id: int, body: EffectIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    own_stream(db, stream_id, user)
    sess = _session(stream_id)
    if not sess.mixer or not sess.mixer.play_effect(body.name):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such sound effect, or the stream is not on air.")
    return {"played": body.name}


@router.post("/{stream_id}/studio/music")
async def upload_music(stream_id: int, file: UploadFile = File(...), user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Background music for the Music fader (MP3, WAV, M4A…, up to 50 MB). Loops while playing."""
    s = own_stream(db, stream_id, user)
    data = file.file.read(50 * 1024 * 1024 + 1)
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Music files can be at most 50 MB.")
    folder = get_settings().live_work_dir / f"music-{s.id}"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"track{Path(file.filename or 'a.mp3').suffix.lower()[:6]}"
    path.write_bytes(data)
    state, sess = _state_for(db, s)
    state["music_file"], state["music_playing"] = str(path), True
    if sess and sess.mixer:
        await asyncio.to_thread(sess.mixer.load_music, path, True)
    _save_state(db, s, state)
    return {"music": True, "playing": True}


class MusicIn(BaseModel):
    playing: bool


@router.post("/{stream_id}/studio/music/play")
async def play_music(stream_id: int, body: MusicIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    s = own_stream(db, stream_id, user)
    state, sess = _state_for(db, s)
    if not state.get("music_file"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Upload a music track first.")
    state["music_playing"] = body.playing
    if sess and sess.mixer:
        await asyncio.to_thread(sess.mixer.load_music, Path(state["music_file"]), body.playing)
    _save_state(db, s, state)
    return {"playing": body.playing}


class AlertIn(BaseModel):
    kind: str = Field(pattern="^(follower|superchat)$")
    name: str = Field(min_length=1, max_length=40)
    amount: float | None = Field(None, ge=0)


def show_alert(stream_id: int, text: str) -> None:
    sess = SUPERVISOR.sessions.get(stream_id)
    if sess:
        sess.alert = {"text": text, "until": time.time() + 6}
        SUPERVISOR.refresh_overlay(sess)
        if sess.mixer:
            sess.mixer.play_effect("Ding")


@router.post("/{stream_id}/alerts")
async def alert(stream_id: int, body: AlertIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Shows a follower or Super Chat alert on the program for 6 s (with a chime)."""
    own_stream(db, stream_id, user)
    text = f"{body.name} just followed!" if body.kind == "follower" else f"{body.name} sent ${body.amount or 0:.2f}"
    await asyncio.to_thread(show_alert, stream_id, text)
    return {"shown": text}


class AdminMuteIn(BaseModel):
    muted: bool


@router.post("/{stream_id}/admin-mute")
async def admin_mute(stream_id: int, body: AdminMuteIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """For a stream flagged by the Rights Manager: an administrator mutes its sound instead of stopping it."""
    if user.role != Role.admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only administrators can do this.")
    s = own_stream(db, stream_id, user)
    s.audio_muted_by_admin = body.muted
    state, sess = _state_for(db, s)
    state["mixer"]["master"]["muted"] = body.muted
    if sess and sess.mixer:
        sess.mixer.state = state
        await asyncio.to_thread(sess.mixer.send, f"volume@ch_master volume {sess.mixer._gain('master')}")
    _save_state(db, s, state)
    from app.services.actions import notify

    notify(db, s.creator_id, "An administrator muted your live stream's sound because it matches protected content." if body.muted
           else "An administrator turned your live stream's sound back on.", f"/live-studio?id={s.id}")
    db.commit()
    return {"admin_muted": body.muted}


# ---- chat ------------------------------------------------------------------------------------------------------------

LINK = re.compile(r"(https?://|www\.)\S+", re.I)


def _chat_out(m: ChatMessage) -> dict:
    return {"id": m.id, "user_id": m.user_id, "username": m.username, "text": m.text, "pinned": m.pinned, "kind": m.kind,
            "amount_cents": m.amount_cents, "created_at": m.created_at}


@router.get("/{stream_id}/chat")
def chat(stream_id: int, after: int = Query(0, ge=0), q: str | None = Query(None, max_length=40), user: User | None = Depends(optional_user),
         db: Session = Depends(get_db)) -> dict:
    s = visible_stream(db, stream_id, user)
    stmt = select(ChatMessage).where(ChatMessage.stream_id == s.id, ChatMessage.hidden.is_(False), ChatMessage.id > after).order_by(ChatMessage.id.desc()).limit(100)
    if q:
        stmt = stmt.where(ChatMessage.text.ilike(f"%{q}%") | ChatMessage.username.ilike(f"%{q}%"))
    msgs = list(db.scalars(stmt))[::-1]
    pinned = db.scalar(select(ChatMessage).where(ChatMessage.stream_id == s.id, ChatMessage.pinned.is_(True), ChatMessage.hidden.is_(False)).order_by(ChatMessage.id.desc()))
    return {"messages": [_chat_out(m) for m in msgs], "pinned": _chat_out(pinned) if pinned else None, "slow_mode_seconds": s.slow_mode_seconds}


class ChatIn(BaseModel):
    text: str = Field(min_length=1, max_length=300)
    superchat_cents: int | None = Field(None, ge=100, le=50000)


def moderation_reason(s: LiveStream, text: str) -> str | None:
    low = text.lower()
    for w in s.blocked_words or []:
        if w and w.lower() in low:
            return "contains a blocked word"
    if s.auto_moderate:
        if LINK.search(text):
            return "links are not allowed in this chat"
        letters = [c for c in text if c.isalpha()]
        if len(letters) >= 12 and sum(c.isupper() for c in letters) / len(letters) > 0.8:
            return "too many capital letters"
        if re.search(r"(.)\1{9,}", text):
            return "repeated characters"
    return None


@router.post("/{stream_id}/chat", status_code=status.HTTP_201_CREATED)
def send_chat(stream_id: int, body: ChatIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    s = visible_stream(db, stream_id, user)
    if s.status == LiveStatus.Ended:
        raise HTTPException(status.HTTP_409_CONFLICT, "The stream has ended.")
    is_host = user.id == s.creator_id or user.role == Role.admin
    if not is_host:
        ban = db.scalar(select(ChatBan).where(ChatBan.stream_id == s.id, ChatBan.user_id == user.id).order_by(ChatBan.id.desc()))
        if ban and (ban.until is None or ban.until > datetime.now(UTC)):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You are banned from this chat." if ban.until is None else "You are in a timeout.")
        reason = moderation_reason(s, body.text)
        if reason:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Message held: {reason}.")
        if s.slow_mode_seconds:
            key = f"live:slow:{s.id}:{user.id}"
            if not get_redis().set(key, 1, nx=True, ex=s.slow_mode_seconds):
                raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, f"Slow mode: one message every {s.slow_mode_seconds} s.")
    m = ChatMessage(stream_id=s.id, user_id=user.id, username=user.username, text=body.text.strip(),
                    kind="superchat" if body.superchat_cents else "chat", amount_cents=body.superchat_cents)
    db.add(m)
    db.commit()
    sess = SUPERVISOR.sessions.get(s.id)
    if sess:
        sess.chat = (sess.chat + [{"username": m.username, "text": m.text}])[-6:]
        if sess.state.get("chat_box"):
            SUPERVISOR.refresh_overlay(sess)
        if m.kind == "superchat":
            show_alert(s.id, f"{m.username} sent ${m.amount_cents / 100:.2f}")
    return _chat_out(m)


@router.post("/{stream_id}/chat/{message_id}/pin")
def pin(stream_id: int, message_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    own_stream(db, stream_id, user)
    for m in db.scalars(select(ChatMessage).where(ChatMessage.stream_id == stream_id, ChatMessage.pinned.is_(True))):
        m.pinned = False
    m = db.get(ChatMessage, message_id)
    if m is None or m.stream_id != stream_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Message not found.")
    m.pinned = True
    db.commit()
    return _chat_out(m)


@router.delete("/{stream_id}/chat/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
def hide_message(stream_id: int, message_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> None:
    own_stream(db, stream_id, user)
    m = db.get(ChatMessage, message_id)
    if m and m.stream_id == stream_id:
        m.hidden = True
        db.commit()


class BanIn(BaseModel):
    user_id: int
    minutes: int | None = Field(None, ge=1, le=10080, description="Timeout length; empty bans for the whole stream")


@router.post("/{stream_id}/bans", status_code=status.HTTP_201_CREATED)
def ban(stream_id: int, body: BanIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    s = own_stream(db, stream_id, user)
    if body.user_id == s.creator_id:
        raise HTTPException(status.HTTP_409_CONFLICT, "You cannot ban yourself.")
    until = datetime.now(UTC) + timedelta(minutes=body.minutes) if body.minutes else None
    db.add(ChatBan(stream_id=s.id, user_id=body.user_id, until=until))
    if body.minutes is None:
        for m in db.scalars(select(ChatMessage).where(ChatMessage.stream_id == s.id, ChatMessage.user_id == body.user_id)):
            m.hidden = True
    db.commit()
    return {"user_id": body.user_id, "until": until}


class ModerationIn(BaseModel):
    slow_mode_seconds: int | None = Field(None, ge=0, le=600)
    blocked_words: list[str] | None = None
    auto_moderate: bool | None = None


@router.post("/{stream_id}/moderation")
def moderation(stream_id: int, body: ModerationIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    s = own_stream(db, stream_id, user)
    if body.slow_mode_seconds is not None:
        s.slow_mode_seconds = body.slow_mode_seconds
    if body.blocked_words is not None:
        s.blocked_words = sorted({w.strip().lower() for w in body.blocked_words if w.strip()})[:200]
    if body.auto_moderate is not None:
        s.auto_moderate = body.auto_moderate
    db.commit()
    return {"slow_mode_seconds": s.slow_mode_seconds, "blocked_words": s.blocked_words, "auto_moderate": s.auto_moderate}


# ---- viewers ---------------------------------------------------------------------------------------------------------

class HeartbeatIn(BaseModel):
    viewer_id: str = Field(min_length=8, max_length=64)


@router.post("/{stream_id}/heartbeat")
def heartbeat(stream_id: int, body: HeartbeatIn, user: User | None = Depends(optional_user), db: Session = Depends(get_db)) -> dict:
    """Viewers ping every 15 s; anyone seen in the last 30 s counts as watching."""
    s = visible_stream(db, stream_id, user)
    r = get_redis()
    key = f"live:viewers:{s.id}"
    r.zadd(key, {body.viewer_id: time.time()})
    r.expire(key, 3600)
    r.zremrangebyscore(key, 0, time.time() - 30)
    return {"viewers": r.zcard(key)}


@router.post("/{stream_id}/like")
def like(stream_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    s = visible_stream(db, stream_id, user)
    if get_redis().set(f"live:like:{s.id}:{user.id}", 1, nx=True, ex=7 * 86400):
        s.likes = (s.likes or 0) + 1
        db.commit()
    return {"likes": s.likes}


# ---- guests and screen share (browser -> WebSocket -> FFmpeg -> RTMP) ------------------------------------------------

def _ingest_token(stream_id: int, kind: str, minutes: int) -> str:
    return jwt.encode({"sid": stream_id, "kind": kind, "exp": datetime.now(UTC) + timedelta(minutes=minutes), "n": secrets.token_hex(4)},
                      get_settings().jwt_secret, algorithm="HS256")


@router.post("/{stream_id}/guest-invite")
def guest_invite(stream_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """A link a guest opens to join with camera and microphone (valid 6 hours)."""
    s = own_stream(db, stream_id, user)
    token = _ingest_token(s.id, "guest", 360)
    return {"url": f"{get_settings().frontend_url.rstrip('/')}/guest/{token}", "token": token, "expires_in_minutes": 360}


@router.post("/{stream_id}/screen-token")
def screen_token(stream_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    s = own_stream(db, stream_id, user)
    return {"token": _ingest_token(s.id, "screen", 60)}


@router.get("/guest/{token}")
def guest_info(token: str, db: Session = Depends(get_db)) -> dict:
    try:
        claims = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This invite link is not valid any more.") from None
    s = db.get(LiveStream, claims["sid"])
    if s is None or s.status == LiveStatus.Ended:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This stream has ended.")
    return {"stream_id": s.id, "title": s.title, "host": s.creator.username, "kind": claims["kind"], "live": s.status == LiveStatus.Live}


@router.websocket("/ingest")
async def ingest(ws: WebSocket, token: str) -> None:
    """The browser sends WebM (MediaRecorder) pieces; FFmpeg turns them into <key>-guest / <key>-screen on the RTMP server."""
    try:
        claims = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        await ws.close(code=4401)
        return
    sess = SUPERVISOR.sessions.get(claims["sid"])
    if sess is None or claims["kind"] not in ("guest", "screen"):
        await ws.close(code=4409)
        return
    await ws.accept()
    target = f"{get_settings().rtmp_internal_url.rstrip('/')}/{sess.key}-{claims['kind']}"
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-fflags", "+genpts", "-f", "webm", "-i", "pipe:0",
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-g", "60", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-f", "flv", target,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    try:
        while True:
            data = await ws.receive_bytes()
            if proc.stdin is None or proc.returncode is not None:
                break
            proc.stdin.write(data)
            await proc.stdin.drain()
    except (WebSocketDisconnect, ConnectionResetError, BrokenPipeError):
        pass
    finally:
        if proc.stdin and not proc.stdin.is_closing():
            proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            proc.kill()
