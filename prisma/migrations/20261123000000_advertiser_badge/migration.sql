ALTER TYPE "PaymentPurpose" ADD VALUE 'AD_BADGE';
ALTER TABLE "User" ADD COLUMN "adBadgeUntil" TIMESTAMP(3);
ALTER TABLE "CreatorEligibility" ADD COLUMN "suspendedAt" TIMESTAMP(3);
