"""Phase 1 end to end with the real processes: RTMP server, API, mixer, restreams, chat and VOD on (stand-in) Hetzner.

Run alone with:  PYTHONPATH=. pytest -q tests/test_live.py   (about 2 minutes; needs node, ffmpeg, PostgreSQL, Redis)
"""

import shutil
import time
from pathlib import Path

import boto3
import httpx
import pytest

from tests.live_harness import Platform, kill, publish, receiver, free_port

pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="needs Node.js for the RTMP server")


@pytest.fixture(scope="module")
def plat():
    p = Platform()
    try:
        yield p.start()
    finally:
        p.stop()


def until(fn, timeout=30.0, every=0.5, what="condition"):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(every)
    raise AssertionError(f"timed out waiting for {what} (last: {last!r})")


@pytest.fixture(scope="module")
def creator(plat):
    c = httpx.Client(base_url=plat.api, timeout=30)
    tok = c.post("/api/auth/register", json={"username": "host", "email": "host@example.com", "password": "password123"}).json()["access_token"]
    c.headers["Authorization"] = f"Bearer {tok}"
    return c


def studio(c, sid):
    return c.get(f"/api/live/{sid}/studio").json()


def test_invalid_stream_key_is_refused(plat, creator):
    p = publish(f"{plat.rtmp}/live_fake_fake_fake_fake", seconds=6)
    p.wait(timeout=20)
    assert p.returncode != 0
    assert "invalid or disabled stream key" in plat.log("rtmp")
    assert all(s["status"] != "Live" for s in creator.get("/api/live").json())


def test_go_live_restream_switch_mix_chat_and_vod(plat, creator):
    c = creator
    key = c.get("/api/stream-keys/me").json()
    assert key["key"].startswith("live_") and key["rtmp_url"] == plat.rtmp
    sid = c.post("/api/live", json={"title": "Integration show", "category": "Technology", "privacy": "Public"}).json()["id"]
    assert c.post(f"/api/live/{sid}/go-live").json()["armed"] is True
    assert studio(c, sid)["waiting_for_encoder"] is True

    # Two fake destinations (as if YouTube and Twitch).
    ports = [free_port(), free_port()]
    outs = [plat.tmp / "dest_a.flv", plat.tmp / "dest_b.flv"]
    recv = [receiver(ports[i], outs[i]) for i in range(2)]
    for i, platform in enumerate(("YouTube", "Twitch")):
        r = c.post(f"/api/live/{sid}/destinations", json={"platform": platform, "rtmp_url": f"rtmp://127.0.0.1:{ports[i]}/app", "stream_key": "key"})
        assert r.status_code == 201, r.text

    obs = publish(f"{plat.rtmp}/{key['key']}")
    try:
        s = until(lambda: (lambda d: d if d["on_air"] else None)(studio(c, sid)), 40, what="on air")
        assert s["stream"]["status"] == "Live" and s["waiting_for_encoder"] is False
        h = until(lambda: (lambda d: d["health"] if d["health"].get("bitrate_kbps") else None)(studio(c, sid)), 15, what="bitrate")
        assert h["resolution"] == "640x360" and h["label"] in ("Excellent", "Connection poor", "Encoder overloaded")

        # HLS preview is served.
        hls = s["stream"]["hls_url"]
        until(lambda: httpx.get(hls).status_code == 200 and ".ts" in httpx.get(hls).text, 30, what="HLS playlist")

        # Both destinations receive the same program.
        until(lambda: all(d["status"] == "Connected" for d in studio(c, sid)["destinations"]), 30, what="destinations connected")
        until(lambda: all(o.exists() and o.stat().st_size > 50_000 for o in outs), 30, what="destinations receiving")

        # One destination fails: it shows Error, the other keeps receiving.
        kill(recv[0])
        until(lambda: [d["status"] for d in studio(c, sid)["destinations"]] == ["Error", "Connected"], 40, what="A error, B connected")
        size = outs[1].stat().st_size
        until(lambda: outs[1].stat().st_size > size + 20_000, 15, what="B still growing")

        # Audio mixer: Mic 1 carries the tone; muting it silences its meter; the fader moves.
        until(lambda: studio(c, sid)["levels"]["mic1"] > -40, 20, what="mic1 level")
        assert c.post(f"/api/live/{sid}/studio/mixer", json={"channel": "mic1", "muted": True}).json()["muted"] is True
        until(lambda: studio(c, sid)["levels"]["mic1"] <= -89, 10, what="mic1 silent")
        c.post(f"/api/live/{sid}/studio/mixer", json={"channel": "mic1", "muted": False, "volume": 0.5})
        until(lambda: studio(c, sid)["levels"]["mic1"] > -40, 10, what="mic1 back")

        # Sound effect reaches the Sound Effects meter.
        assert c.post(f"/api/live/{sid}/studio/sfx", json={"name": "Applause"}).status_code == 200
        until(lambda: studio(c, sid)["levels"]["sfx"] > -40, 8, every=0.25, what="sfx level")

        # A second camera joins; switching it to Program and the BRB scene work while live.
        cam2 = publish(f"{plat.rtmp}/{key['key']}-cam2", pattern="mandelbrot", tone=550)
        try:
            until(lambda: any(x["name"] == "cam2" and x["connected"] for x in studio(c, sid)["sources"]) and studio(c, sid)["on_air"], 40, what="cam2")
            until(lambda: c.post(f"/api/live/{sid}/studio/program", json={"source": "cam2", "transition": "fade"}).status_code == 200, 20, what="switch")
            assert studio(c, sid)["state"]["program"] == "cam2"
            assert c.post(f"/api/live/{sid}/studio/scene", json={"name": "BRB"}).json()["muted"] == ["mic1", "mic2", "guest"]
            until(lambda: studio(c, sid)["levels"]["master"] <= -89, 10, what="BRB silences microphones")
            c.post(f"/api/live/{sid}/studio/scene", json={"name": "Main"})
            until(lambda: studio(c, sid)["levels"]["master"] > -40, 10, what="Main restores sound")
            assert c.post(f"/api/live/{sid}/studio/overlay", json={"lower_third": {"enabled": True, "name": "Ada", "title": "Host"}}).status_code == 200
            assert (plat.tmp / "live" / str(sid) / "overlay.png").exists()
        finally:
            kill(cam2)

        # Chat with moderation.
        v = httpx.Client(base_url=plat.api, timeout=30)
        v.headers["Authorization"] = "Bearer " + v.post("/api/auth/register", json={"username": "fan", "email": "fan@example.com", "password": "password123"}).json()["access_token"]
        c.post(f"/api/live/{sid}/moderation", json={"slow_mode_seconds": 30, "blocked_words": ["spoiler"], "auto_moderate": True})
        assert v.post(f"/api/live/{sid}/chat", json={"text": "hello!"}).status_code == 201
        assert v.post(f"/api/live/{sid}/chat", json={"text": "again"}).status_code == 429
        assert c.post(f"/api/live/{sid}/moderation", json={"slow_mode_seconds": 0}).status_code == 200
        assert v.post(f"/api/live/{sid}/chat", json={"text": "a spoiler!"}).status_code == 422
        assert v.post(f"/api/live/{sid}/chat", json={"text": "see https://spam.example"}).status_code == 422
        assert v.post(f"/api/live/{sid}/heartbeat", json={"viewer_id": "viewer-0001"}).json()["viewers"] == 1

        # The encoder drops and comes back within the reconnect window: still the same live stream.
        kill(obs)
        until(lambda: studio(c, sid)["health"].get("label") == "Reconnecting", 15, what="reconnecting")
        obs = publish(f"{plat.rtmp}/{key['key']}")
        until(lambda: studio(c, sid)["on_air"], 30, what="back on air")
        assert studio(c, sid)["stream"]["status"] == "Live"
        time.sleep(4)
    finally:
        kill(obs)
        for r in recv:
            kill(r)

    # End: the recording is stored on Hetzner as an original and becomes a video.
    assert c.post(f"/api/live/{sid}/end").json()["status"] == "Ended"
    vod = until(lambda: next((s["vod"] for s in c.get("/api/live").json() if s["id"] == sid and s["vod"]), None), 60, what="VOD")
    assert vod["duration"] > 10
    s3 = boto3.client("s3", endpoint_url=plat.env["HETZNER_ENDPOINT"], aws_access_key_id="test", aws_secret_access_key="test", region_name="fsn1")
    keys = [o["Key"] for o in s3.list_objects_v2(Bucket="videos-test-originals").get("Contents", [])]
    assert any(k.startswith("originals/") and k.endswith(".mp4") for k in keys)
    # The live work folder and HLS files are cleaned up.
    until(lambda: not (plat.tmp / "live" / str(sid)).exists(), 20, what="work folder removed")


def test_ended_stream_refuses_automatic_reconnect(plat, creator):
    """After END STREAM, OBS reconnecting by itself does not start a new stream until the creator presses GO LIVE."""
    key = creator.get("/api/stream-keys/me").json()["key"]
    p = publish(f"{plat.rtmp}/{key}", seconds=8)
    p.wait(timeout=25)
    assert "just ended" in plat.log("rtmp")
    assert all(s["status"] == "Ended" for s in creator.get("/api/live").json())


def test_reset_key_invalidates_old(plat, creator):
    old = creator.get("/api/stream-keys/me").json()["key"]
    new = creator.post("/api/stream-keys/reset").json()["key"]
    assert new != old and new.startswith("live_")
    creator.post("/api/live", json={"title": "After reset"})
    creator.post(f"/api/live/{creator.get('/api/live').json()[0]['id']}/go-live")
    p = publish(f"{plat.rtmp}/{old}", seconds=6)
    p.wait(timeout=20)
    assert p.returncode != 0
