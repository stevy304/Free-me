CREATE TABLE "PayoutAccount" (
  "id" TEXT NOT NULL, "channelId" TEXT NOT NULL, "country" TEXT NOT NULL,
  "provider" TEXT NOT NULL, "accountIdentifier" TEXT NOT NULL, "accountHolderName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "version" INTEGER NOT NULL DEFAULT 1,
  "reviewNote" TEXT, "reviewedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayoutAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayoutAccount_status_check" CHECK ("status" IN ('PENDING', 'VERIFIED', 'REJECTED')),
  CONSTRAINT "PayoutAccount_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PayoutAccount_channelId_key" ON "PayoutAccount"("channelId");
CREATE INDEX "PayoutAccount_status_idx" ON "PayoutAccount"("status");
ALTER TABLE "Payout" ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "destinationCurrency" TEXT, ADD COLUMN "destinationAmount" BIGINT,
  ADD COLUMN "feeAmount" BIGINT, ADD COLUMN "exchangeRate" INTEGER;
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "Payout"("idempotencyKey");
