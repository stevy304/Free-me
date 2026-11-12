# Load test results

Run each test again on the real servers before launch and after big changes, and add a row. Numbers from a
shared test machine only show whether a change helps; they are not what production servers will do.

## API (`node deploy/loadtest/api-bench.mjs <url> <at once> <seconds>`)

Mix of requests: home 3, watch page 4, Next 3, video list 2, rising 1, search 1. Data: 3,000 videos, 200 Spaces,
2,000 viewers with 30,000 watch-history rows.

| Date | Machine | API processes | At once | Requests/s | p50 ms | p95 ms | Errors | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2026-11-12 | Test sandbox, 4 vCPU, PostgreSQL, Redis and the load generator on the same machine | 1 | 50 | 162 | 190 | 945 | 0 | Before: home feed p50 894 ms (about 15 queries per visit) |
| 2026-11-12 | same | 1 | 50 | 384 | 110 | 301 | 0 | Shared home parts cached for 60 s (`FEED_CACHE_SECONDS`): home p50 19 ms |
| 2026-11-12 | same | 4 (`API_PROCESSES=auto`) | 100 | 401 | 226 | 536 | 0 | Limited by PostgreSQL sharing the same 4 cores. On separate servers, expect several times more |

**What to run before launch** (on the real servers, from a machine outside them):

1. `node deploy/loadtest/api-bench.mjs https://<domain> 100 60`, then 300, then 1,000. Watch `SlowApi` and CPU on the database server.
2. `BASE=https://<domain> k6 run deploy/loadtest/watch.js` with `PEAK=100`, `500` and `1000`. This also loads video segments from the CDN.
3. Write each result here. The first number that fails tells you what to upgrade first: API CPU means more `API_PROCESSES` or a second app server; database CPU means a bigger database server or a read replica.
