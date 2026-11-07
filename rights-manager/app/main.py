"""Rights Manager API. Run: uvicorn app.main:app --reload"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import auth, checks, destinations, dispute, live, matches, reference, rtmp, stream_key
from app.config import get_settings
from app.db import init_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    from app.services.rtmp_server import SUPERVISOR

    await SUPERVISOR.recover()
    yield
    await SUPERVISOR.shutdown()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="Rights Manager", version="1.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origins=[o.strip() for o in s.cors_origins.split(",") if o.strip()],
        allow_methods=["*"], allow_headers=["*"],
    )
    for r in (auth.router, reference.router, checks.router, matches.router, dispute.router, dispute.notifications,
              stream_key.router, rtmp.router, live.router, destinations.router):
        app.include_router(r)

    # Only thumbnails are public; the videos themselves are never served from here.
    thumbs = s.upload_dir / "thumbnails"
    thumbs.mkdir(parents=True, exist_ok=True)
    app.mount("/media/thumbnails", StaticFiles(directory=thumbs), name="thumbnails")
    # Live HLS from this machine's disk (in production nginx serves /hls and Cloudflare caches it; see README).
    s.hls_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/hls", StaticFiles(directory=s.hls_dir), name="hls")

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True}

    return app


app = create_app()
