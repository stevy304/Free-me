-- AV1 renditions for popular videos: the same resolution can now exist once per codec.
DROP INDEX "VideoRendition_videoId_resolution_key";
CREATE UNIQUE INDEX "VideoRendition_videoId_resolution_codec_key" ON "VideoRendition"("videoId", "resolution", "codec");

ALTER TABLE "Video" ADD COLUMN "av1QueuedAt" TIMESTAMP(3);
CREATE INDEX "Video_av1QueuedAt_viewCount_idx" ON "Video"("av1QueuedAt", "viewCount");
