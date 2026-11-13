-- Comments checked after they are shown (low risk) or before (everything else): see engagement/comment-check.ts.
ALTER TABLE "Comment" ADD COLUMN "checkedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Comment" ADD COLUMN "removedReason" TEXT;
CREATE INDEX "Comment_checkedAt_idx" ON "Comment"("checkedAt");
