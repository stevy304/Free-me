-- CreateEnum
CREATE TYPE "CollectionKind" AS ENUM ('SAVED', 'CUSTOM');

-- AlterEnum
ALTER TYPE "ModerationActionType" ADD VALUE 'VIDEO_RESTORED' AFTER 'VIDEO_TAKEDOWN';

-- DropIndex
DROP INDEX "Playlist_userId_idx";

-- DropIndex
DROP INDEX "PlaylistItem_playlistId_idx";

-- DropIndex
DROP INDEX "Report_status_idx";

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "replyCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ModerationAction" ADD COLUMN     "videoId" TEXT;

-- AlterTable
ALTER TABLE "Playlist" ADD COLUMN     "kind" "CollectionKind" NOT NULL DEFAULT 'CUSTOM',
ALTER COLUMN "visibility" SET DEFAULT 'PRIVATE';

-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "claimantAddress" TEXT,
ADD COLUMN     "claimantEmail" TEXT,
ADD COLUMN     "claimantName" TEXT,
ADD COLUMN     "counterAddress" TEXT,
ADD COLUMN     "counterAt" TIMESTAMP(3),
ADD COLUMN     "counterName" TEXT,
ADD COLUMN     "counterStatement" TEXT,
ADD COLUMN     "originalWork" TEXT,
ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "signature" TEXT,
ADD COLUMN     "timestampSeconds" INTEGER;

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "commentsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "dislikeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "takedownReason" TEXT,
ADD COLUMN     "takenDownAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Comment_videoId_parentId_createdAt_idx" ON "Comment"("videoId", "parentId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_parentId_createdAt_idx" ON "Comment"("parentId", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationAction_videoId_idx" ON "ModerationAction"("videoId");

-- CreateIndex
CREATE INDEX "Playlist_userId_kind_idx" ON "Playlist"("userId", "kind");

-- CreateIndex
CREATE INDEX "PlaylistItem_playlistId_position_idx" ON "PlaylistItem"("playlistId", "position");

-- CreateIndex
CREATE INDEX "PlaylistItem_videoId_idx" ON "PlaylistItem"("videoId");

-- CreateIndex
CREATE INDEX "Report_status_createdAt_idx" ON "Report"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Report_reporterId_idx" ON "Report"("reporterId");
