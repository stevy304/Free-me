"""Request and response shapes for the API."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.models import DisputeStatus, Policy, Role, UploadStatus


class Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=40, pattern=r"^[A-Za-z0-9_.]+$")
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginIn(BaseModel):
    login: str = Field(description="Username or email")
    password: str


class UserOut(Out):
    id: int
    username: str
    email: str
    role: Role
    created_at: datetime


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class ReferenceOut(Out):
    id: int
    title: str
    policy: Policy
    status: str
    error: str | None
    duration: float | None
    file_hash_sha256: str | None
    thumbnail_url: str | None
    frames: int
    has_audio: bool
    owner: str
    created_at: datetime


class PolicyIn(BaseModel):
    policy: Policy


class UploadOut(Out):
    id: int
    title: str | None
    status: UploadStatus
    message: str | None
    duration: float | None
    thumbnail_url: str | None
    audio_removed: bool
    has_watermark: bool
    watermark_text: str | None
    uploader: str
    created_at: datetime
    match_id: int | None = None
    can_dispute: bool = False
    dispute_id: int | None = None


class MatchOut(Out):
    id: int
    upload_id: int
    reference_id: int
    reference_title: str
    reference_owner: str
    reference_thumbnail_url: str | None
    upload_title: str | None
    uploader: str
    upload_thumbnail_url: str | None
    upload_status: UploadStatus
    video_score: float
    audio_score: float | None
    combined_score: float
    exact: bool
    has_watermark: bool
    status: str
    policy: Policy
    created_at: datetime
    dispute_id: int | None = None


class ReviewIn(BaseModel):
    action: str = Field(pattern="^(approve|block)$")
    note: str | None = Field(default=None, max_length=1000)


class DisputeIn(BaseModel):
    match_id: int
    reason: str = Field(min_length=10, max_length=4000)


class RespondIn(BaseModel):
    action: str = Field(pattern="^(release|uphold)$")
    response: str = Field(min_length=3, max_length=4000)


class DecideIn(BaseModel):
    approve: bool
    admin_note: str = Field(min_length=3, max_length=4000)


class DisputeOut(Out):
    id: int
    match_id: int
    upload_id: int
    upload_title: str | None
    upload_thumbnail_url: str | None
    reference_title: str
    reference_owner: str
    uploader: str
    reason: str
    status: DisputeStatus
    creator_response: str | None
    creator_action: str | None
    admin_note: str | None
    respond_by: datetime
    overdue: bool
    created_at: datetime
    decided_at: datetime | None
    combined_score: float


class LogOut(Out):
    id: int
    action: str
    note: str | None
    actor: str | None
    created_at: datetime


class NotificationOut(Out):
    id: int
    text: str
    link: str | None
    read: bool
    created_at: datetime
