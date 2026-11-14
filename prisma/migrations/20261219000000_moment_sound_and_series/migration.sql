-- Moments: the sound they use, and series of episodes.
CREATE TABLE "Series" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Series_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Series_channelId_idx" ON "Series"("channelId");
ALTER TABLE "Series" ADD CONSTRAINT "Series_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Video" ADD COLUMN "soundTitle" TEXT, ADD COLUMN "seriesId" TEXT, ADD COLUMN "episodeNumber" INTEGER;
CREATE INDEX "Video_seriesId_episodeNumber_idx" ON "Video"("seriesId", "episodeNumber");
ALTER TABLE "Video" ADD CONSTRAINT "Video_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE SET NULL ON UPDATE CASCADE;
