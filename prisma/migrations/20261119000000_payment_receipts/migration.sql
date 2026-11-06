ALTER TABLE "Payment" ADD COLUMN "receiptDueAt" TIMESTAMP(3), ADD COLUMN "receiptSentAt" TIMESTAMP(3);
CREATE INDEX "Payment_receiptDueAt_idx" ON "Payment"("receiptDueAt");
ALTER TABLE "Video" ADD COLUMN "captionAttemptedAt" TIMESTAMP(3);
CREATE INDEX "Video_status_captionAttemptedAt_idx" ON "Video"("status", "captionAttemptedAt");
