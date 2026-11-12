-- Live: how far behind real time viewers are (normal or low latency).
ALTER TABLE "LiveStream" ADD COLUMN "latencyMode" TEXT NOT NULL DEFAULT 'normal';
