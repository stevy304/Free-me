-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "token" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "expires" BIGINT NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "videos" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "status" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "duration_seconds" DOUBLE PRECISION,
    "owner_id" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'public',

    CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_email_key" ON "accounts"("email");

-- CreateIndex
CREATE INDEX "sessions_account_id_idx" ON "sessions"("account_id");

-- CreateIndex
CREATE INDEX "sessions_expires_idx" ON "sessions"("expires");

-- CreateIndex
CREATE UNIQUE INDEX "videos_sequence_key" ON "videos"("sequence");

-- CreateIndex
CREATE INDEX "videos_status_visibility_sequence_idx" ON "videos"("status", "visibility", "sequence");

-- CreateIndex
CREATE INDEX "videos_owner_id_sequence_idx" ON "videos"("owner_id", "sequence");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_email_normalized" CHECK ("email" = lower(trim("email")));
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_expiry_positive" CHECK ("expires" > 0);
ALTER TABLE "videos"
  ADD CONSTRAINT "videos_status_valid" CHECK ("status" IN ('processing', 'ready', 'failed')),
  ADD CONSTRAINT "videos_visibility_valid" CHECK ("visibility" IN ('public', 'private')),
  ADD CONSTRAINT "videos_private_has_owner" CHECK ("visibility" <> 'private' OR "owner_id" IS NOT NULL),
  ADD CONSTRAINT "videos_metadata_object" CHECK (jsonb_typeof("metadata") = 'object'),
  ADD CONSTRAINT "videos_duration_valid" CHECK ("duration_seconds" IS NULL OR ("duration_seconds" > 0 AND "duration_seconds" < 'Infinity'::float8));
