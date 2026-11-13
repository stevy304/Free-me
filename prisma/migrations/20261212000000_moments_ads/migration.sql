-- Ads between Moments, paid to creators from a Moments pool (45%, shared by Moments views), like Shorts on YouTube.
CREATE TYPE "AdPlacement" AS ENUM ('PRE_ROLL', 'MOMENTS');
ALTER TABLE "AdImpression" ADD COLUMN "placement" "AdPlacement" NOT NULL DEFAULT 'PRE_ROLL';
CREATE INDEX "AdImpression_placement_createdAt_idx" ON "AdImpression"("placement", "createdAt");
ALTER TABLE "AdDaySettlement" ADD COLUMN "momentsGrossCents" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "AdDaySettlement" ADD COLUMN "momentsPoolCents" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "AdDaySettlement" ADD COLUMN "momentsAllocatedCents" BIGINT NOT NULL DEFAULT 0;
