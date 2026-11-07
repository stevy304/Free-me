from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


engine = create_engine(get_settings().database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Creates the tables (an Alembic migration would replace this in production)."""
    from app import models  # noqa: F401  (registers every model)

    with engine.begin() as conn:
        # Columns and enum values added after the first release (create_all does not alter existing tables).
        conn.exec_driver_sql("DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_type WHERE typname='user_role') THEN ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'viewer'; END IF; END $$")
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql("ALTER TABLE users ADD COLUMN IF NOT EXISTS plan user_plan NOT NULL DEFAULT 'free'")
        conn.exec_driver_sql("ALTER TABLE users ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false")
