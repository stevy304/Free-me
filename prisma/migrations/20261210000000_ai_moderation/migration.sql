-- Automatic decisions by the AI moderator: publish, limit or reject, why, by which model; limiting and appeals.
ALTER TABLE "Video" ADD COLUMN "safetyDecision" TEXT, ADD COLUMN "safetyReason" TEXT, ADD COLUMN "safetyModel" TEXT,
  ADD COLUMN "safetyLimitedAt" TIMESTAMP(3), ADD COLUMN "appealedAt" TIMESTAMP(3);
CREATE INDEX "Video_safetyLimitedAt_idx" ON "Video"("safetyLimitedAt");
