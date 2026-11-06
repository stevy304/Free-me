-- CreateEnum
CREATE TYPE "CaptionSource" AS ENUM ('UPLOADED', 'AUTO');

-- CreateTable
CREATE TABLE "Caption" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "source" "CaptionSource" NOT NULL,
    "key" TEXT NOT NULL,
    "cueCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Caption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Caption_videoId_language_key" ON "Caption"("videoId", "language");

-- AddForeignKey
ALTER TABLE "Caption" ADD CONSTRAINT "Caption_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

