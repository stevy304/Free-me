-- Popularity-based encoding, a quality limit for free viewers, and ads priced per 1,000 views.
ALTER TABLE "Video" ADD COLUMN "hlsFullMasterKey" TEXT;
ALTER TABLE "Video" ADD COLUMN "hdPending" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Video_hdPending_viewCount_idx" ON "Video"("hdPending", "viewCount");

ALTER TABLE "Campaign" ADD COLUMN "deliverUntil" TIMESTAMP(3);
