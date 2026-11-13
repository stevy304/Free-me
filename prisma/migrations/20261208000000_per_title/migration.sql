-- Per-title encoding: the CRF chosen for each video, and each rendition's measured peak and average bitrate.
ALTER TABLE "Video" ADD COLUMN "encodeCrf" INTEGER;
ALTER TABLE "VideoRendition" ADD COLUMN "peakKbps" INTEGER, ADD COLUMN "averageKbps" INTEGER;
