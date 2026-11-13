-- What viewers experienced while playing, counted per hour and per country, codec, device and connection.
CREATE TABLE "QoeHourly" (
    "hour" TIMESTAMP(3) NOT NULL,
    "country" TEXT NOT NULL,
    "codec" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "startupBuckets" INTEGER[],
    "playedSeconds" BIGINT NOT NULL DEFAULT 0,
    "stalls" INTEGER NOT NULL DEFAULT 0,
    "stallMs" BIGINT NOT NULL DEFAULT 0,
    "stalledSessions" INTEGER NOT NULL DEFAULT 0,
    "qualitySeconds" BIGINT NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "QoeHourly_pkey" PRIMARY KEY ("hour","country","codec","device","network")
);
CREATE INDEX "QoeHourly_hour_idx" ON "QoeHourly"("hour");
