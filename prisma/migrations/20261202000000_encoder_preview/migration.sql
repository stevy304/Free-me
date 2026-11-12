ALTER TYPE "LiveStatus" ADD VALUE 'PREVIEW';
ALTER TABLE "LiveStream"
  ADD COLUMN "finalizedAt" TIMESTAMP(3),
  ADD COLUMN "encoderConnectedAt" TIMESTAMP(3),
  ADD COLUMN "encoderHeartbeatAt" TIMESTAMP(3),
  ADD COLUMN "encoderStartSequence" INTEGER,
  ADD COLUMN "ingestHealth" JSONB;

-- Existing encoder broadcasts were already public before private previews were introduced.
UPDATE "LiveStream" SET "encoderStartSequence" = 0 WHERE "source" = 'rtmp' AND "status" IN ('LIVE', 'ENDED');
