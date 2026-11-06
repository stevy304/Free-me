-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'LIVE';

-- CreateEnum
CREATE TYPE "LiveStatus" AS ENUM ('IDLE', 'LIVE', 'ENDED');

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "liveStreamKey" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "liveStreamId" TEXT;

-- CreateTable
CREATE TABLE "LiveStream" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "LiveStatus" NOT NULL DEFAULT 'IDLE',
    "source" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "peakViewers" INTEGER NOT NULL DEFAULT 0,
    "replayVideoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveStream_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveStream_status_startedAt_idx" ON "LiveStream"("status", "startedAt");

-- CreateIndex
CREATE INDEX "LiveStream_channelId_createdAt_idx" ON "LiveStream"("channelId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_liveStreamKey_key" ON "Channel"("liveStreamKey");

-- AddForeignKey
ALTER TABLE "LiveStream" ADD CONSTRAINT "LiveStream_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

