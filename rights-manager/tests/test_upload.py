"""Phases 2-3: resumable direct upload to (stand-in) Hetzner, limits by account, deduplication, TUS-style fallback."""

import hashlib
import subprocess

import boto3
import httpx
import pytest

from tests.live_harness import PY, ROOT, Platform

GB = 1024 ** 3


@pytest.fixture(scope="module")
def plat():
    p = Platform()
    try:
        yield p.start()
    finally:
        p.stop()


@pytest.fixture(scope="module")
def video(plat) -> bytes:
    out = plat.tmp / "clip.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30", "-f", "lavfi", "-i", "sine=f=440",
                    "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "12M", "-c:a", "aac", str(out)], check=True)
    return out.read_bytes()  # ~18 MB: 4 parts of 5 MB


def account(plat, name, *, plan=None, verified=None, role=None) -> httpx.Client:
    c = httpx.Client(base_url=plat.api, timeout=60)
    c.headers["Authorization"] = "Bearer " + c.post("/api/auth/register", json={"username": name, "email": f"{name}@example.com", "password": "password123"}).json()["access_token"]
    if plan or verified is not None or role:
        sets = ", ".join(x for x in (f"plan='{plan}'" if plan else "", f"verified={str(verified).lower()}" if verified is not None else "", f"role='{role}'" if role else "") if x)
        subprocess.run([PY, "-c", f"from app.db import engine\nwith engine.begin() as c: c.exec_driver_sql(\"UPDATE users SET {sets} WHERE username='{name}'\")"],
                       env=plat.env, cwd=ROOT, check=True)
    return c


def s3(plat):
    return boto3.client("s3", endpoint_url=plat.env["HETZNER_ENDPOINT"], aws_access_key_id="test", aws_secret_access_key="test", region_name="fsn1")


def put_parts(c, uid, data, chunk, numbers):
    urls = c.post(f"/api/uploads/{uid}/sign", json={"part_numbers": numbers}).json()["urls"]
    for n in numbers:
        body = data[(n - 1) * chunk: n * chunk]
        r = httpx.put(urls[str(n)], content=body, timeout=60)  # straight to storage, not through the API
        assert r.status_code == 200, r.text
        assert c.post(f"/api/uploads/{uid}/progress", json={"part_number": n, "etag": r.headers["etag"], "size": len(body)}).status_code == 200


def test_limits_by_account(plat):
    free = account(plat, "free_user")
    lim = free.get("/api/uploads/limits").json()
    assert lim["max_bytes"] == 2 * GB and lim["tier"] == "free"
    assert free.post("/api/uploads/create", json={"file_name": "a.mp4", "file_size": 3 * GB}).status_code == 413
    assert free.post("/api/uploads/create", json={"file_name": "a.avi", "file_size": 1000}).status_code == 415
    paid = account(plat, "paid_user", plan="paid")
    assert paid.post("/api/uploads/create", json={"file_name": "a.mkv", "file_size": 9 * GB}).status_code == 201
    assert paid.post("/api/uploads/create", json={"file_name": "a.mov", "file_size": 11 * GB}).status_code == 413
    big = account(plat, "verified_user", verified=True)
    r = big.post("/api/uploads/create", json={"file_name": "film.mp4", "file_size": 100 * GB})
    assert r.status_code == 201
    # 100 GB fits S3's 10,000-part limit with larger parts.
    assert r.json()["total_chunks"] <= 10_000 and r.json()["chunk_size"] >= 10 * 1024 * 1024
    viewer = account(plat, "just_watching", role="viewer")
    assert viewer.post("/api/uploads/create", json={"file_name": "a.mp4", "file_size": 1000}).status_code == 403


def test_pause_resume_complete_and_deduplicate(plat, video):
    c = account(plat, "uploader")
    sha = hashlib.sha256(video).hexdigest()
    s = c.post("/api/uploads/create", json={"file_name": "Holiday.mp4", "file_size": len(video)}).json()
    uid, chunk, n = s["upload_id"], s["chunk_size"], s["total_chunks"]
    assert chunk == 5 * 1024 * 1024 and n == -(-len(video) // chunk)
    put_parts(c, uid, video, chunk, list(range(1, n // 2 + 1)))
    c.post(f"/api/uploads/{uid}/pause")
    # "Refresh": the client asks where it was. Hetzner's part list is the truth.
    h = c.head(f"/api/uploads/{uid}")
    assert int(h.headers["upload-offset"]) == (n // 2) * chunk and h.headers["x-uploaded-chunks"] == str(n // 2)
    done = c.get(f"/api/uploads/{uid}/parts").json()["done"]
    assert done == list(range(1, n // 2 + 1))
    assert c.post(f"/api/uploads/{uid}/complete").status_code == 409  # parts missing
    put_parts(c, uid, video, chunk, [k for k in range(1, n + 1) if k not in done])
    c.post(f"/api/uploads/{uid}/hash", json={"sha256": sha})
    assert c.post(f"/api/uploads/{uid}/complete").status_code == 202
    s = c.get(f"/api/uploads/{uid}").json()
    assert s["status"] == "Completed"
    v = next(x for x in c.get("/api/videos/mine").json() if x["id"] == s["video_id"])
    assert v["status"] in ("Processing", "Ready", "Published") and v["duration"] == pytest.approx(12, abs=0.5)
    keys = [o["Key"] for o in s3(plat).list_objects_v2(Bucket="videos-test-originals").get("Contents", [])]
    assert f"originals/{sha}.mp4" in keys  # content-addressed
    assert not any(k.startswith("uploads/") for k in keys)  # the assembly copy is gone
    # The same file again: linked at once, nothing uploaded.
    again = c.post("/api/uploads/create", json={"file_name": "Holiday copy.mp4", "file_size": len(video), "sha256": sha}).json()
    assert again["status"] == "Completed" and again["duplicate_of"] == s["video_id"]
    # Details can be filled while processing.
    assert c.patch(f"/api/videos/{s['video_id']}", json={"title": "Holiday 2026", "tags": ["travel", "sea"], "category": "Travel"}).json()["tags"] == ["sea", "travel"]


def test_tus_style_fallback_through_the_api(plat, video):
    c = account(plat, "proxy_user")
    s = c.post("/api/uploads/create", json={"file_name": "Proxy.mp4", "file_size": len(video)}).json()
    uid, chunk = s["upload_id"], s["chunk_size"]
    assert c.patch(f"/api/uploads/{uid}/chunk", content=video[:100], headers={"Content-Range": f"bytes 0-99/{len(video)}"}).status_code == 416
    for start in range(0, len(video), chunk):
        end = min(start + chunk, len(video)) - 1
        r = c.patch(f"/api/uploads/{uid}/chunk", content=video[start:end + 1], headers={"Content-Range": f"bytes {start}-{end}/{len(video)}"})
        assert r.status_code == 204, r.text
        assert int(r.headers["upload-offset"]) == end + 1
    assert c.post(f"/api/uploads/{uid}/complete").status_code == 202
    assert c.get(f"/api/uploads/{uid}").json()["status"] == "Completed"
    assert not list((plat.tmp / "tmp" / "chunks").glob("*/*"))  # temporary parts deleted


def test_corrupt_file_is_rejected_and_cancel_cleans_up(plat):
    c = account(plat, "careless")
    junk = b"this is not a video " * 400_000  # 8 MB
    s = c.post("/api/uploads/create", json={"file_name": "broken.mp4", "file_size": len(junk)}).json()
    put_parts(c, s["upload_id"], junk, s["chunk_size"], list(range(1, s["total_chunks"] + 1)))
    c.post(f"/api/uploads/{s['upload_id']}/complete")
    s = c.get(f"/api/uploads/{s['upload_id']}").json()
    assert s["status"] == "Failed" and "not a readable video" in s["error"]
    t = c.post("/api/uploads/create", json={"file_name": "nevermind.mp4", "file_size": len(junk)}).json()
    assert c.delete(f"/api/uploads/{t['upload_id']}").status_code == 204
    assert c.get(f"/api/uploads/{t['upload_id']}").status_code == 404
    assert all(v["id"] != t["video_id"] for v in c.get("/api/videos/mine").json())
    ups = s3(plat).list_multipart_uploads(Bucket="videos-test-originals").get("Uploads", [])
    assert not any(t["upload_id"] in u["Key"] for u in ups)


def test_stream_bucket_keeps_private_objects_private(plat):
    endpoint = plat.env["HETZNER_ENDPOINT"]
    bucket = "videos-test-stream"
    s3 = boto3.client("s3", endpoint_url=endpoint, region_name="fsn1",
                      aws_access_key_id="test", aws_secret_access_key="test")
    s3.put_object(Bucket=bucket, Key="private.m3u8", Body=b"#EXTM3U")
    s3.put_object(Bucket=bucket, Key="published.m3u8", Body=b"#EXTM3U", ACL="public-read")
    assert httpx.get(f"{endpoint}/{bucket}/private.m3u8").status_code == 403
    assert httpx.get(f"{endpoint}/{bucket}/published.m3u8").status_code == 200
