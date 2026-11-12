-- "People who watched this also watched": the latest viewers of a video, found without scanning every history.
CREATE INDEX "WatchHistory_videoId_lastWatchedAt_idx" ON "WatchHistory"("videoId", "lastWatchedAt");
