-- Batches of counted views already written, so a batch retried after a worker crash is never counted twice.
CREATE TABLE "CounterFlush" (
    "stamp" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CounterFlush_pkey" PRIMARY KEY ("stamp")
);
CREATE INDEX "CounterFlush_createdAt_idx" ON "CounterFlush"("createdAt");
