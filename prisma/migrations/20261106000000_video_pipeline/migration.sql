-- Phase 2: video pipeline. Storage keys replace URLs (the CDN or a signed link is chosen when serving), processing
-- progress and errors, public/private media location, thumbnail choices and an audience flag. No videos exist yet.
-- CreateEnum
CREATE TYPE "MediaLocation" AS ENUM ('PUBLIC', 'PRIVATE');

-- AlterTable
ALTER TABLE "Video" DROP COLUMN "animatedPreviewUrl",
DROP COLUMN "masterPlaylistUrl",
DROP COLUMN "thumbnailUrl",
ADD COLUMN     "customThumbnail" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "hlsMasterKey" TEXT,
ADD COLUMN     "madeForKids" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mediaLocation" "MediaLocation" NOT NULL DEFAULT 'PRIVATE',
ADD COLUMN     "processingError" TEXT,
ADD COLUMN     "processingProgress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "processingStage" TEXT,
ADD COLUMN     "sourceSizeBytes" BIGINT,
ADD COLUMN     "thumbnailCandidates" TEXT[],
ADD COLUMN     "thumbnailKey" TEXT,
ADD COLUMN     "uploadId" TEXT,
ADD COLUMN     "width" INTEGER;

-- AlterTable
ALTER TABLE "VideoRendition" DROP COLUMN "playlistUrl",
ADD COLUMN     "codecs" TEXT NOT NULL DEFAULT 'avc1.640028,mp4a.40.2',
ADD COLUMN     "frameRate" DOUBLE PRECISION NOT NULL DEFAULT 30,
ADD COLUMN     "playlistKey" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Video_channelId_createdAt_idx" ON "Video"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "Video_status_visibility_isShort_publishedAt_idx" ON "Video"("status", "visibility", "isShort", "publishedAt");

