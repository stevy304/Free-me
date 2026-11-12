-- A video reported by several established accounts is hidden until a moderator reviews it.
ALTER TABLE "Video" ADD COLUMN "reviewHoldAt" TIMESTAMP(3);
