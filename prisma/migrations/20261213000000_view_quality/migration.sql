-- Views judged not valid (automated or abusive traffic, media/view-quality.ts): recorded per video and day, never counted.
ALTER TABLE "VideoDailyStat" ADD COLUMN "invalidViews" INTEGER NOT NULL DEFAULT 0;
