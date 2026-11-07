import enum
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Role(str, enum.Enum):
    creator = "creator"
    admin = "admin"
    viewer = "viewer"


class Plan(str, enum.Enum):
    free = "free"
    paid = "paid"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(100))
    role: Mapped[Role] = mapped_column(Enum(Role, name="user_role"), default=Role.creator)
    # Upload limits: free 2 GB, paid 10 GB, verified creators 100 GB.
    plan: Mapped[Plan] = mapped_column(Enum(Plan, name="user_plan"), default=Plan.free, server_default="free")
    verified: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
