"""Rights Manager API. Run: uvicorn app.main:app --reload"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import auth, dispute, matches, reference, upload
from app.config import get_settings
from app.db import init_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="Rights Manager", version="1.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origins=[o.strip() for o in s.cors_origins.split(",") if o.strip()],
        allow_methods=["*"], allow_headers=["*"],
    )
    for r in (auth.router, reference.router, upload.router, matches.router, dispute.router, dispute.notifications):
        app.include_router(r)

    # Only thumbnails are public; the videos themselves are never served from here.
    thumbs = s.upload_dir / "thumbnails"
    thumbs.mkdir(parents=True, exist_ok=True)
    app.mount("/media/thumbnails", StaticFiles(directory=thumbs), name="thumbnails")

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True}

    return app


app = create_app()
