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

## Browsing as signed-in viewers, larger catalogue

`SESSIONS=sessions.txt node deploy/loadtest/api-bench.mjs <url> 100 30` (adds For you; `ONLY=foryou` measures one endpoint). Data: 20,000 videos in 200 Spaces over 21 topics, 3,000 signed-in viewers with 50 watches and 10 reactions each. Nearly every For you request is a viewer's first (the ranking is then kept 10 minutes), so this is For you's worst case.

| Date | Machine | API processes | At once | Requests/s | p50 ms | p95 ms | For you p50 ms | Search p50 ms | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2026-11-13 | Test sandbox, 4 vCPU, everything on one machine | 1 | 100 | 90 | 668 | 3,559 | 2,613 | 2,513 | First run: search read every video; For you computed related lists during requests |
| 2026-11-13 | same | 1 | 100 | 257 | 239 | 1,357 | 1,216 | 191 | Search through indexes (full text, trigram, tags), first pages reused for 60 s |
| 2026-11-13 | same | 1 | 100 | 384 | 182 | 865 | 756 | 133 | For you: only prepared related lists, features as one string per video (MGET), scoring without per-part objects |
| 2026-11-13 | same, `ONLY=foryou` | 1 | 50 | 221 | 263 | 393 | 263 | | For you alone, first requests: about 4.5 ms of API CPU each |

Without other load, For you takes about 30 ms for a viewer's first request and 8 ms after. The worker rebuilds the feature store for 16,711 videos in 1.5 s and 386 related lists in 0.6 s.

## Watching (`node deploy/loadtest/player-bench.mjs <url> <players> <seconds>`)

What playing videos send: resume position 8, watch time 2, view 1, playback health 1. Each simulated player stays on one video with one account for 40 reports. 3,000 accounts, 30 videos; API with `TRUST_PROXY=1` so each player has its own address.

| Date | Machine | API processes | Players | Requests/s | p50 ms | p95 ms | Errors | DB transactions / 30 s | DB rows written / 30 s | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2026-11-13 | Test sandbox, 4 vCPU, everything on one machine | 1 | 100 | 899 | 107 | 156 | 0 | 76,263 | 17,632 | Before: a database read and write per position save, two reads per signed-in request |
| 2026-11-13 | same | 1 | 100 | 1,447 | 65 | 105 | 0 | 87,768 | 1,127 | Positions batched in Redis, video facts cached for 10 s, view counts written in 3 statements |
| 2026-11-13 | same | 1 | 100 | 1,850 | 50 | 82 | 0 | 6,076 | 719 | Sessions cached for 15 s (`SESSION_CACHE_SECONDS`) |

**What to run before launch** (on the real servers, from a machine outside them):

1. `node deploy/loadtest/api-bench.mjs https://<domain> 100 60`, then 300, then 1,000. Watch `SlowApi` and CPU on the database server.
2. On a staging copy (never production: it writes watch history), `make-sessions.mjs` then `player-bench.mjs` with 1,000, 5,000 and 20,000 players from several machines.
3. `BASE=https://<domain> k6 run deploy/loadtest/watch.js` with `PEAK=100`, `500` and `1000`. This also loads video segments from the CDN.
4. Write each result here. The first number that fails tells you what to upgrade first: API CPU means more `API_PROCESSES` or a second app server; database CPU means a bigger database server or a read replica.
