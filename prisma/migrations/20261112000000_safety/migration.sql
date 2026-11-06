-- CreateEnum
CREATE TYPE "HashAlgorithm" AS ENUM ('SHA256', 'MD5');

-- CreateEnum
CREATE TYPE "BlockedHashSource" AS ENUM ('TAKEDOWN', 'LIST');

-- AlterTable
ALTER TABLE "Report" ALTER COLUMN "reporterId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "screeningClearedAt" TIMESTAMP(3),
ADD COLUMN     "sourceMd5" TEXT,
ADD COLUMN     "sourceSha256" TEXT;

-- CreateTable
CREATE TABLE "BlockedHash" (
    "id" TEXT NOT NULL,
    "algorithm" "HashAlgorithm" NOT NULL,
    "value" TEXT NOT NULL,
    "source" "BlockedHashSource" NOT NULL,
    "note" TEXT,
    "videoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedHash_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BlockedHash_algorithm_value_key" ON "BlockedHash"("algorithm", "value");

-- CreateIndex
CREATE INDEX "Video_sourceSha256_idx" ON "Video"("sourceSha256");

