-- Content ID: fingerprints of every upload, the search index, protected works and claims (media/content-id.ts).
-- CreateEnum
CREATE TYPE "RightsPolicy" AS ENUM ('BLOCK', 'MONETIZE', 'TRACK');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('ACTIVE', 'DISPUTED', 'RELEASED');

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "rightsVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ContentFingerprint" (
    "videoId" TEXT NOT NULL,
    "frames" BYTEA NOT NULL,
    "audio" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentFingerprint_pkey" PRIMARY KEY ("videoId")
);

-- CreateTable
CREATE TABLE "FingerprintKey" (
    "key" BIGINT NOT NULL,
    "videoId" TEXT NOT NULL,
    "at" INTEGER NOT NULL,

    CONSTRAINT "FingerprintKey_pkey" PRIMARY KEY ("key","videoId","at")
);

-- CreateTable
CREATE TABLE "ContentReference" (
    "videoId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "policy" "RightsPolicy" NOT NULL DEFAULT 'BLOCK',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentReference_pkey" PRIMARY KEY ("videoId")
);

-- CreateTable
CREATE TABLE "ContentClaim" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "referenceVideoId" TEXT NOT NULL,
    "ownerChannelId" TEXT NOT NULL,
    "policy" "RightsPolicy" NOT NULL,
    "matched" TEXT NOT NULL,
    "matchedSeconds" INTEGER NOT NULL,
    "uploadStart" INTEGER NOT NULL,
    "referenceStart" INTEGER NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'ACTIVE',
    "disputeReason" TEXT,
    "disputedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FingerprintKey_videoId_idx" ON "FingerprintKey"("videoId");

-- CreateIndex
CREATE INDEX "ContentReference_channelId_idx" ON "ContentReference"("channelId");

-- CreateIndex
CREATE INDEX "ContentClaim_ownerChannelId_createdAt_idx" ON "ContentClaim"("ownerChannelId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentClaim_videoId_status_idx" ON "ContentClaim"("videoId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ContentClaim_videoId_referenceVideoId_key" ON "ContentClaim"("videoId", "referenceVideoId");

-- AddForeignKey
ALTER TABLE "ContentFingerprint" ADD CONSTRAINT "ContentFingerprint_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentReference" ADD CONSTRAINT "ContentReference_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentReference" ADD CONSTRAINT "ContentReference_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentClaim" ADD CONSTRAINT "ContentClaim_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentClaim" ADD CONSTRAINT "ContentClaim_referenceVideoId_fkey" FOREIGN KEY ("referenceVideoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentClaim" ADD CONSTRAINT "ContentClaim_ownerChannelId_fkey" FOREIGN KEY ("ownerChannelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

