from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Role, User
from app.schemas import LoginIn, RegisterIn, TokenOut, UserOut
from app.security import check_password, get_current_user, hash_password, make_token

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
def register(body: RegisterIn, db: Session = Depends(get_db)) -> TokenOut:
    """Creates a creator account. Administrators are made with the seed script or `python -m app.make_admin`."""
    taken = db.scalar(select(User).where(or_(func.lower(User.username) == body.username.lower(), func.lower(User.email) == body.email.lower())))
    if taken:
        field = "username" if taken.username.lower() == body.username.lower() else "email"
        raise HTTPException(status.HTTP_409_CONFLICT, f"That {field} is already used.")
    user = User(username=body.username, email=body.email.lower(), password_hash=hash_password(body.password), role=Role.creator)
    db.add(user)
    db.commit()
    return TokenOut(access_token=make_token(user), user=UserOut.model_validate(user))


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: Session = Depends(get_db)) -> TokenOut:
    who = body.login.strip().lower()
    user = db.scalar(select(User).where(or_(func.lower(User.username) == who, User.email == who)))
    if user is None or not check_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong username, email or password.")
    return TokenOut(access_token=make_token(user), user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> User:
    return user
