"""The whole service through its API: accounts, originals, checks, policies, review, disputes, limits."""

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import Base, SessionLocal, engine
from app.main import app as api
from app.models import Role, User


@pytest.fixture()
def client():
    Base.metadata.drop_all(engine)
    with TestClient(api) as c:
        yield c


def account(c, name, admin=False):
    r = c.post("/api/auth/register", json={"username": name, "email": f"{name}@example.com", "password": "password123"})
    assert r.status_code == 201, r.text
    if admin:
        with SessionLocal() as db:
            db.query(User).filter(User.username == name).update({"role": Role.admin})
            db.commit()
    tok = c.post("/api/auth/login", json={"login": name, "password": "password123"}).json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}


def add_reference(c, h, path, policy="Block", title="Original"):
    with open(path, "rb") as f:
        r = c.post("/api/references", headers=h, data={"title": title, "policy": policy}, files={"file": (path.name, f, "video/mp4")})
    assert r.status_code == 201, r.text
    ref = c.get(f"/api/references/{r.json()['id']}", headers=h).json()
    assert ref["status"] == "ready", ref
    return ref


def check(c, h, path, title="My video"):
    with open(path, "rb") as f:
        r = c.post("/api/checks", headers=h, data={"title": title}, files={"file": (path.name, f, "video/mp4")})
    assert r.status_code == 202, r.text
    up = c.get(f"/api/checks/{r.json()['id']}", headers=h).json()  # what the page polls every 2 s
    assert up["status"] != "Processing"
    return up


def test_accounts(client):
    h = account(client, "maker")
    assert client.get("/api/auth/me", headers=h).json()["role"] == "creator"
    assert client.post("/api/auth/register", json={"username": "Maker", "email": "x@example.com", "password": "password123"}).status_code == 409
    assert client.post("/api/auth/login", json={"login": "maker", "password": "wrong-password"}).status_code == 401
    assert client.get("/api/references").status_code == 401
    assert client.get("/api/matches/review", headers=h).status_code == 403


def test_reference_is_fingerprinted_and_listed(client, videos):
    h = account(client, "maker")
    ref = add_reference(client, h, videos["original"])
    assert ref["frames"] == 10 and ref["has_audio"] and len(ref["file_hash_sha256"]) == 64
    assert client.get(ref["thumbnail_url"]).status_code == 200
    assert [r["id"] for r in client.get("/api/references", headers=h).json()] == [ref["id"]]
    assert client.patch(f"/api/references/{ref['id']}", headers=h, json={"policy": "Mute"}).json()["policy"] == "Mute"
    other = account(client, "someone")
    assert client.get(f"/api/references/{ref['id']}", headers=other).status_code == 404


def test_file_type_and_size_limits(client, videos):
    h = account(client, "maker")
    assert client.post("/api/checks", headers=h, files={"file": ("a.avi", b"x" * 10, "video/x-msvideo")}).status_code == 415
    s = get_settings()
    before, s.max_upload_mb = s.max_upload_mb, 0
    try:
        with open(videos["original"], "rb") as f:
            assert client.post("/api/checks", headers=h, files={"file": ("a.mp4", f, "video/mp4")}).status_code == 413
    finally:
        s.max_upload_mb = before
    bad = check(client, h, _broken(videos))
    assert bad["status"] == "Failed"


def _broken(videos):
    p = videos["original"].with_name("broken.mp4")
    p.write_bytes(b"not a video at all" * 100)
    return p


def test_exact_copy_is_blocked_with_message_and_owner_sees_it(client, videos):
    owner = account(client, "maker")
    add_reference(client, owner, videos["original"])
    thief = account(client, "copycat")
    up = check(client, thief, videos["copy"])
    assert up["status"] == "Blocked"
    assert up["message"] == "This video cannot be posted, it matches original content by @maker"
    assert up["can_dispute"]
    ms = client.get("/api/matches", headers=owner).json()
    assert len(ms) == 1 and ms[0]["exact"] and ms[0]["combined_score"] == 100 and ms[0]["uploader"] == "copycat"
    assert client.get("/api/matches?status=blocked&q=copy", headers=owner).json()[0]["id"] == ms[0]["id"]
    assert client.get("/api/matches?q=nobody", headers=owner).json() == []
    assert client.get("/api/matches", headers=thief).json() == []  # not their original
    # The owner's own re-upload is never checked against their own original.
    assert check(client, owner, videos["copy"])["status"] == "Approved"
    assert any("copycat" in n["text"] for n in client.get("/api/notifications", headers=owner).json())


def test_mirrored_copy_is_blocked_and_unrelated_is_approved(client, videos):
    owner = account(client, "maker")
    add_reference(client, owner, videos["original"])
    u = account(client, "uploader")
    flipped = check(client, u, videos["hflip"])
    assert flipped["status"] == "Blocked"
    m = client.get("/api/matches", headers=owner).json()[0]
    assert not m["exact"] and m["combined_score"] >= 85 and m["video_score"] >= 85
    assert check(client, u, videos["other"])["status"] == "Approved"
    assert len(client.get("/api/matches", headers=owner).json()) == 1


def test_mute_policy_posts_without_sound(client, videos):
    owner = account(client, "maker")
    add_reference(client, owner, videos["original"], policy="Mute")
    up = check(client, account(client, "uploader"), videos["mute_src"])
    assert up["status"] == "Approved" and up["audio_removed"] and up["message"] == "Audio removed due to copyright"


def test_flag_policy_goes_to_admin_review(client, videos):
    owner = account(client, "maker")
    add_reference(client, owner, videos["original"], policy="Flag")
    u = account(client, "uploader")
    up = check(client, u, videos["mute_src"])
    assert up["status"] == "Flagged"
    admin = account(client, "boss", admin=True)
    queue = client.get("/api/matches/review", headers=admin).json()
    assert [q["upload_id"] for q in queue] == [up["id"]]
    assert client.post(f"/api/matches/{queue[0]['id']}/review", headers=owner, json={"action": "approve"}).status_code == 403
    assert client.post(f"/api/matches/{queue[0]['id']}/review", headers=admin, json={"action": "approve", "note": "Licensed"}).status_code == 200
    assert client.get(f"/api/checks/{up['id']}", headers=u).json()["status"] == "Approved"
    assert client.get("/api/matches/review", headers=admin).json() == []


def test_track_policy_posts_and_records(client, videos):
    owner = account(client, "maker")
    add_reference(client, owner, videos["original"], policy="Track")
    assert check(client, account(client, "uploader"), videos["hflip"])["status"] == "Approved"
    assert client.get("/api/matches?status=tracked", headers=owner).json()[0]["uploader"] == "uploader"


def test_watermark_is_detected(client, videos):
    up = check(client, account(client, "uploader"), videos["tiktok"])
    assert up["has_watermark"] and up["watermark_text"] == "TikTok"


def test_dispute_released_by_creator(client, videos):
    owner = account(client, "maker")
    add_reference(client, owner, videos["original"])
    u = account(client, "uploader")
    up = check(client, u, videos["copy"])
    assert client.post("/api/disputes", headers=u, json={"match_id": up["match_id"], "reason": "short"}).status_code == 422
    d = client.post("/api/disputes", headers=u, json={"match_id": up["match_id"], "reason": "I bought a licence for this clip."}).json()
    assert d["status"] == "Pending" and not d["overdue"]
    assert client.post("/api/disputes", headers=u, json={"match_id": up["match_id"], "reason": "Again and again."}).status_code == 409
    assert any("disputed" in n["text"] for n in client.get("/api/notifications", headers=owner).json())
    assert client.post(f"/api/disputes/{d['id']}/respond", headers=u, json={"action": "release", "response": "Not mine to release"}).status_code == 403
    r = client.post(f"/api/disputes/{d['id']}/respond", headers=owner, json={"action": "release", "response": "Yes, they have a licence."}).json()
    assert r["status"] == "Approved"
    assert client.get(f"/api/checks/{up['id']}", headers=u).json()["status"] == "Approved"
    assert [x["action"] for x in client.get(f"/api/disputes/{d['id']}/log", headers=u).json()] == ["opened", "creator_released"]


def test_dispute_upheld_then_admin_decides(client, videos):
    owner = account(client, "maker")
    add_reference(client, owner, videos["original"])
    u = account(client, "uploader")
    admin = account(client, "boss", admin=True)
    up = check(client, u, videos["copy"])
    d = client.post("/api/disputes", headers=u, json={"match_id": up["match_id"], "reason": "This is fair use commentary."}).json()
    client.post(f"/api/disputes/{d['id']}/respond", headers=owner, json={"action": "uphold", "response": "It is a full copy."})
    assert client.post(f"/api/disputes/{d['id']}/decide", headers=owner, json={"approve": True, "admin_note": "x" * 5}).status_code == 403
    assert [x["id"] for x in client.get("/api/disputes?status=Pending", headers=admin).json()] == [d["id"]]
    r = client.post(f"/api/disputes/{d['id']}/decide", headers=admin, json={"approve": False, "admin_note": "Full copy, no commentary."}).json()
    assert r["status"] == "Rejected" and r["admin_note"] == "Full copy, no commentary."
    assert client.get(f"/api/checks/{up['id']}", headers=u).json()["status"] == "Blocked"
    assert client.post(f"/api/disputes/{d['id']}/decide", headers=admin, json={"approve": True, "admin_note": "Changed my mind"}).status_code == 409
    log = client.get(f"/api/disputes/{d['id']}/log", headers=owner).json()
    assert [(x["action"], x["actor"]) for x in log] == [("opened", "uploader"), ("creator_upheld", "maker"), ("admin_rejected", "boss")]
    assert any("rejected" in n["text"] for n in client.get("/api/notifications", headers=u).json())


def test_admin_approves_dispute(client, videos):
    owner = account(client, "maker")
    add_reference(client, owner, videos["original"])
    u = account(client, "uploader")
    admin = account(client, "boss", admin=True)
    up = check(client, u, videos["copy"])
    d = client.post("/api/disputes", headers=u, json={"match_id": up["match_id"], "reason": "I am the original author."}).json()
    client.post(f"/api/disputes/{d['id']}/decide", headers=admin, json={"approve": True, "admin_note": "Proof of authorship provided."})
    assert client.get(f"/api/checks/{up['id']}", headers=u).json()["status"] == "Approved"
