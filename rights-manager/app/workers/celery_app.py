from celery import Celery

from app.config import get_settings

s = get_settings()
celery = Celery("rights_manager", broker=s.redis_url, backend=s.redis_url, include=["app.workers.tasks"])
celery.conf.update(
    task_acks_late=True,  # a worker that dies mid-video gives the job back
    worker_prefetch_multiplier=1,  # videos are long jobs: take one at a time
    task_track_started=True,
    task_always_eager=s.celery_eager,
    task_eager_propagates=False,
    broker_connection_retry_on_startup=True,
)
