-- Plans: Plus (no ads, every quality), Family & TV (Plus for up to 4 people), and their share for creators.
ALTER TYPE "PaymentPurpose" ADD VALUE 'PLUS';
ALTER TYPE "PaymentPurpose" ADD VALUE 'FAMILY';
ALTER TABLE "User" ADD COLUMN "plusUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "familyUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "familyOwnerId" TEXT;
ALTER TABLE "User" ADD CONSTRAINT "User_familyOwnerId_fkey" FOREIGN KEY ("familyOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "User_familyOwnerId_idx" ON "User"("familyOwnerId");
ALTER TABLE "VideoDailyStat" ADD COLUMN "plusWatchSeconds" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "AdDaySettlement" ADD COLUMN "subscriptionPoolCents" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "AdDaySettlement" ADD COLUMN "subscriptionAllocatedCents" BIGINT NOT NULL DEFAULT 0;
