"""Processing pipeline for uploads and live VODs (Phase 4 fills this in: GPU jobs per quality)."""

import logging

log = logging.getLogger(__name__)


def enqueue_processing(video_id: str) -> None:
    log.info("processing queued for %s", video_id)
