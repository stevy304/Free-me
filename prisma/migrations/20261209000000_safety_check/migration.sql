-- Automatic safety check: uploads stay hidden until it passes (existing videos count as checked).
ALTER TABLE "Video" ADD COLUMN "safetyCheckedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
-- Moderators' queue order.
ALTER TABLE "Report" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "Report_status_priority_idx" ON "Report"("status", "priority");
-- Terms the text check looks for, maintained by moderators.
CREATE TABLE "SafetyTerm" (
    "id" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SafetyTerm_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SafetyTerm_term_language_category_key" ON "SafetyTerm"("term", "language", "category");
