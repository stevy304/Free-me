ALTER TYPE "PaymentPurpose" ADD VALUE 'CREATOR_SUPPORT';
ALTER TABLE "Channel" ADD COLUMN "supportEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Payment" ADD COLUMN "supportChannelId" TEXT, ADD COLUMN "supportClearedAt" TIMESTAMP(3), ADD COLUMN "requestKey" TEXT;
CREATE UNIQUE INDEX "Payment_requestKey_key" ON "Payment"("requestKey");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_supportChannelId_fkey" FOREIGN KEY ("supportChannelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Payment_supportChannelId_status_idx" ON "Payment"("supportChannelId", "status");
