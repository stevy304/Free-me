-- Live settings: description, who can find it, schedule, chat controls, live captions, and the replay.
ALTER TABLE "LiveStream" ADD COLUMN "description" TEXT;
ALTER TABLE "LiveStream" ADD COLUMN "visibility" "Visibility" NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE "LiveStream" ADD COLUMN "scheduledFor" TIMESTAMP(3);
ALTER TABLE "LiveStream" ADD COLUMN "chatMode" TEXT NOT NULL DEFAULT 'everyone';
ALTER TABLE "LiveStream" ADD COLUMN "slowModeSeconds" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LiveStream" ADD COLUMN "captionsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "LiveStream" ADD COLUMN "saveReplay" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "LiveStream" ADD COLUMN "replayVisibility" "Visibility" NOT NULL DEFAULT 'PRIVATE';
