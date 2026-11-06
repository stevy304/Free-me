-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateIndex
CREATE INDEX "Channel_name_trgm_idx" ON "Channel" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Video_title_trgm_idx" ON "Video" USING GIN ("title" gin_trgm_ops);
