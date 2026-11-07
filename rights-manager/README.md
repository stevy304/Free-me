# Rights Manager

Protect original videos the way Content ID / Rights Manager do. Creators register originals, every new upload is fingerprinted (frames + sound) and compared with them, and a policy decides what happens: **Block**, **Mute**, **Flag** for review, or **Track**. Uploaders can dispute; owners answer within 7 days; administrators decide. Every dispute step is logged.

| Part | Tech |
|---|---|
| API | FastAPI, SQLAlchemy 2, PostgreSQL, JWT (roles `creator`, `admin`) |
| Background work | Celery + Redis (the API never waits for a check) |
| Video | FFmpeg / ffprobe, pHash (imagehash + Pillow), OpenCV |
| Sound | Chromaprint through pyacoustid |
| Watermarks | Tesseract OCR (pytesseract), OpenCV fallback |
| Web | Next.js 14 (App Router), Tailwind, shadcn/ui |
| Files | Local `UPLOAD_DIR` (`references/`, `checks/`, `thumbnails/`); `app/storage.py` is the place for an S3 backend |

## How matching works

1. **Exact file**: the SHA-256 is the same as an original's, so the score is 100 and a Block policy applies at once.
2. **Video**: one frame every 2 s. Each frame keeps four 64-bit pHashes:
   - the whole frame with plain borders trimmed;
   - the centre 70 %;
   - mirrored versions of both.

   Each upload frame is matched with its closest original frame by Hamming distance. A distance of 10 or less counts as the same picture and 22 or more as unrelated, with the score falling in a line between them. The video score is the average. This survives crops, flips, letterboxing, colour filters and speed changes.
3. **Audio**: the upload's Chromaprint fingerprint, plus 22 variants that undo common edits, is compared with the original's. The variants cover:
   - speed 0.8–1.25×, with pitch kept;
   - speed 0.8–1.25× with pitch moving with it;
   - pitch ±10 %.

   Windows of about 10 s slide to their best alignment, and the share of equal bits becomes the score.
4. **Combined** = video × 0.6 + audio × 0.4 (video only if either has no sound). A TikTok / CapCut / YouTube watermark in a corner adds **+10**.
5. **≥ 85** applies the original's policy, **70–84** goes to the admin review queue, and **< 70** is approved. When several originals match, the strictest outcome wins.

Measured on generated test videos (`tests/test_matching.py`):

| Upload | Combined score |
|---|---|
| Same file | 100 |
| Mirrored | 97 |
| 1.2× speed | 100 |
| Unrelated | 4–12 |

Further calibration runs scored:
- crop, colour filter, letterbox and pitch ±10 %: 92–100;
- an edit stacking flip + crop + filter + speed: 100.

## Run on Ubuntu (no Docker needed)

```bash
sudo apt install -y python3-venv ffmpeg libchromaprint-tools tesseract-ocr postgresql redis-server
sudo -u postgres psql -c "create role rights login password 'rights'" -c "create database rights owner rights"

cd rights-manager
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # set JWT_SECRET to a long random value

python -m app.seed            # 2 accounts (creator, admin) + 1 protected video; prints the password
uvicorn app.main:app --port 8000                       # API  (docs at http://localhost:8000/docs)
celery -A app.workers.celery_app worker -l info -c 2   # worker, in another terminal

cd frontend
npm install
cp .env.example .env.local    # NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev                   # http://localhost:3000
```

If you prefer containers for PostgreSQL and Redis only, run `docker-compose up -d` instead of installing them. That is optional; nothing else uses Docker.

Make an existing account an administrator: `python -m app.make_admin <username or email>`.

## API

| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login`; GET `/api/auth/me` | anyone / signed in |
| POST, GET | `/api/references` (multipart: `file`, `title`, `policy`) | creator |
| GET, PATCH (policy), DELETE | `/api/references/{id}` | owner |
| POST, GET | `/api/uploads`; GET `/api/uploads/{id}` (the page polls this every 2 s) | signed in |
| GET | `/api/matches?status=&q=` | owner (own originals) / admin (all) |
| GET | `/api/matches/review`; POST `/api/matches/{id}/review` `{action: approve or block}` | admin |
| POST, GET | `/api/disputes`; GET `/api/disputes/{id}`, `/api/disputes/{id}/log` | uploader, owner, admin |
| POST | `/api/disputes/{id}/respond` `{action: release or uphold, response}` | owner of the original |
| POST | `/api/disputes/{id}/decide` `{approve, admin_note}` | admin |
| GET | `/api/notifications`; POST `/api/notifications/read` | signed in |

Limits: MP4, MOV and WebM only, up to 500 MB (`MAX_UPLOAD_MB`), enforced in the browser and again by the API while streaming.

## Tests

```bash
sudo -u postgres createdb -O rights rights_test
PYTHONPATH=. pytest -q          # 19 tests; test videos are generated with FFmpeg
cd frontend && npm run typecheck && npm run lint && npm run build
```

## Notes

- Audio comparison cost grows with original length × upload length. For a large library, add a first pass (an inverted index of fingerprint values) before the full comparison.
- Tables are created at start-up (`init_db`). Add Alembic before changing the schema in production.
