-- Creator pass: uploading after a channel's free videos needs the pass (or Premium).
ALTER TYPE "PaymentPurpose" ADD VALUE 'CREATOR_PASS';
ALTER TABLE "User" ADD COLUMN "creatorPassUntil" TIMESTAMP(3);
ALTER TABLE "Channel" ADD COLUMN "uploadCount" INTEGER NOT NULL DEFAULT 0;
-- Existing channels: their uploads so far count towards the free videos.
UPDATE "Channel" c SET "uploadCount" = (SELECT count(*) FROM "Video" v WHERE v."channelId" = c."id" AND NOT v."isAd");
