"""Gives an existing account the administrator role:  python -m app.make_admin <username or email>"""

import sys

from sqlalchemy import func, or_, select

from app.db import SessionLocal, init_db
from app.models import Role, User


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Usage: python -m app.make_admin <username or email>")
    who = sys.argv[1].strip().lower()
    init_db()
    with SessionLocal() as db:
        user = db.scalar(select(User).where(or_(func.lower(User.username) == who, User.email == who)))
        if user is None:
            sys.exit(f"No account {who!r}. Register it first.")
        user.role = Role.admin
        db.commit()
        print(f"@{user.username} is now an administrator.")


if __name__ == "__main__":
    main()
