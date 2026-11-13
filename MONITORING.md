# Monitoring

You should hear about a problem before your users tell you. Everything here is free, open-source software that runs on servers you already have. The only extra piece is a free outside uptime check.

| What | Tool | Cost |
| --- | --- | --- |
| Numbers from the API, the worker and the machines | Prometheus + node exporter | Free (runs on the database server, or on the single server of a one-machine launch) |
| Alerts to your phone | Alertmanager → Telegram (or email) | Free |
| Dashboards | Grafana (open-source edition) | Free |
| "Is the whole server down?" | An outside uptime service such as UptimeRobot's free plan, checking `https://<domain>/api/health` every 5 minutes | Free |
| Errors with details | The API's JSON logs (`journalctl -u freeme-api`), one line per request with a `requestId` | Free |

The outside check is needed because Prometheus cannot warn you when its own server is down.

## 1. Turn on the metrics

In `/etc/freeme/freeme.env` (every server):

```
METRICS_TOKEN=<openssl rand -hex 24>
# On the media node only:
WORKER_METRICS_PORT=9464
WORKER_METRICS_HOST=10.0.1.30        # the media node's private address (127.0.0.1 on a one-machine launch)
```

Restart the API and worker. Check from the Prometheus server:

```
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://10.0.1.10:4000/api/metrics | head
```

Without the token both endpoints answer 404. The Caddy edge also refuses `/api/metrics` from the internet. Allow port 4000 and port 9464 from the Prometheus server in `ufw` if Prometheus runs on another machine.

## 2. Prometheus, alerts and Telegram

On the database server (or the single server):

```
sudo apt install prometheus prometheus-node-exporter prometheus-alertmanager prometheus-blackbox-exporter
sudo cp deploy/monitoring/prometheus.yml deploy/monitoring/alerts.yml /etc/prometheus/
sudo cp deploy/monitoring/alertmanager.yml /etc/prometheus/alertmanager.yml
echo -n "$METRICS_TOKEN" | sudo tee /etc/prometheus/freeme.token >/dev/null
sudo chown root:prometheus /etc/prometheus/freeme.token && sudo chmod 640 /etc/prometheus/freeme.token
sudo promtool check config /etc/prometheus/prometheus.yml
sudo systemctl restart prometheus prometheus-alertmanager
```

Edit the addresses in `prometheus.yml` to match your servers, and your domain in the `freeme-public` job. Install `prometheus-node-exporter` on every server and allow port 9100 from the Prometheus server only. Keep Prometheus (9090) and Alertmanager (9093) closed to the internet. To look at them, use an SSH tunnel: `ssh -L 9090:localhost:9090 <server>`.

For Telegram alerts, follow the comments in `alertmanager.yml`. Older Alertmanager versions without `bot_token_file` take the token directly as `bot_token`.

## 3. Dashboards (optional)

Install Grafana OSS from Grafana's apt repository. Add Prometheus (`http://localhost:9090`) as a data source, then import the community dashboard **Node Exporter Full** (ID 1860) for the machines. A first panel set for Free Me:

| Panel | Query |
| --- | --- |
| Requests per second | `sum(rate(freeme_http_requests_total[5m]))` |
| Error rate | `sum(rate(freeme_http_requests_total{status=~"5.."}[5m])) / sum(rate(freeme_http_requests_total[5m]))` |
| Slowest routes (p95) | `topk(10, histogram_quantile(0.95, sum by (le, route) (rate(freeme_http_request_duration_seconds_bucket[10m]))))` |
| Uploads waiting | `freeme_media_queue_jobs{state=~"waiting\|prioritized"}` |
| Oldest upload not playable yet | `freeme_videos_processing{measure="oldest_seconds"}` |
| Encoding time | `histogram_quantile(0.5, sum by (le, job) (rate(freeme_worker_job_duration_seconds_bucket[1h])))` |
| Videos waiting for HD views | `freeme_videos_hd_pending` |

## Alerts

Defined in `deploy/monitoring/alerts.yml`:

| Alert | Means | Look first at |
| --- | --- | --- |
| `SiteDown` | The public site or `/api/health` does not answer | Caddy on the edge, then `systemctl status freeme-api` |
| `ApiTargetDown` | An API or worker process stopped reporting | `journalctl -u freeme-api -n 200` (or `freeme-worker@1`) |
| `HighErrorRate` | Over 2% of API requests fail | API logs with `"level":"error"` |
| `SlowApi` | 95% of requests take over 1 s | Database server CPU and disk |
| `UploadsWaiting` / `MediaQueueBacklog` | Uploads wait too long to become playable | Media worker; add one or raise `WORKER_CONCURRENCY` |
| `WorkerJobsFailing` | Media jobs keep failing | `journalctl -u 'freeme-worker@*'` |
| `ViewersRebuffering` | In a country (and codec), viewers spent over 2% of watching time waiting, for 2 hours | Administration → Playback Health by connection and device; the CDN's logs for that country |
| `SlowStart` | 1 in 10 playbacks in a country took over 5 s to show a picture | CDN cache hit rate and first-byte time there; `SlowApi` |
| `PlaybackFailures` | Over 1% of playbacks fail in a country (and codec) | `codec="av1"`: the AV1 renditions (`AV1_MIN_VIEWS=0` stops new ones); otherwise the CDN and signed links |
| `DiskFilling` / `MemoryLow` | A server is running out of space or memory | Scratch directory on the media node; backups on the database node |

## What the metrics are

| Metric | From | Meaning |
| --- | --- | --- |
| `freeme_http_requests_total{method,route,status}` | API | Requests by route pattern (`/api/videos/:id`, never the id) |
| `freeme_http_request_duration_seconds` | API | Response time histogram by route |
| `freeme_media_queue_jobs{queue,state}` | API | Media jobs waiting, active, delayed, failed |
| `freeme_videos_processing{measure}` | API | Uploads not yet playable and the age of the oldest |
| `freeme_videos_hd_pending` | API | Videos whose 1080p and above wait for viewers |
| `freeme_worker_jobs_total{job,result}` | Worker | Jobs finished: `done`, `failed`, `busy` (retried) |
| `freeme_worker_job_duration_seconds{job}` | Worker | How long transcodes, upgrades and moves take |
| `freeme_process_*`, `freeme_nodejs_*` | Both | Memory, CPU, event-loop lag of each process |

The platform-wide numbers (queue and video counts) are the same on every API instance. Use `max()` rather than `sum()` for them.
