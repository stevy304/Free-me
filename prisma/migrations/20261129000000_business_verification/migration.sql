-- Verified business badge: a business applies, an administrator checks it, the business pays for a year.
ALTER TYPE "PaymentPurpose" ADD VALUE 'VERIFICATION';
CREATE TABLE "BusinessVerification" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "website" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "verifiedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessVerification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BusinessVerification_channelId_key" ON "BusinessVerification"("channelId");
CREATE INDEX "BusinessVerification_status_idx" ON "BusinessVerification"("status");
ALTER TABLE "BusinessVerification" ADD CONSTRAINT "BusinessVerification_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
