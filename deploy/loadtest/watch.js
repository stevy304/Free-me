// Load test for Free Me with k6 (free, open source: https://k6.io; on Ubuntu `sudo apt install k6` after adding
// k6's apt repository, or download the single binary). Run it from a machine OUTSIDE your servers:
//
//   BASE=https://freeme.example k6 run deploy/loadtest/watch.js                  # ramps to 500 viewers
//   BASE=https://freeme.example PEAK=2000 k6 run deploy/loadtest/watch.js
//
// Each virtual viewer opens the home page, lists videos, opens one watch page, then loads its HLS playlist and
// segments as a player would (from the CDN), and reports a view. Watch the API's /api/admin/system, CPU and
// database load while it runs. Passing thresholds: 95% of pages under 1.5 s, under 1% errors.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE || 'http://localhost:3000';
const PEAK = Number(__ENV.PEAK || 500);

export const options = {
  stages: [
    { duration: '2m', target: Math.round(PEAK / 5) },
    { duration: '3m', target: PEAK },
    { duration: '5m', target: PEAK },
    { duration: '2m', target: 0 },
  ],
  thresholds: { 'http_req_failed': ['rate<0.01'], 'http_req_duration{kind:page}': ['p(95)<1500'], 'http_req_duration{kind:api}': ['p(95)<800'] },
};

export default function () {
  check(http.get(`${BASE}/`, { tags: { kind: 'page' } }), { 'home 200': (r) => r.status === 200 });
  const list = http.get(`${BASE}/api/videos?limit=24`, { tags: { kind: 'api' } });
  const videos = (list.json('videos') || []).filter((v) => v.playbackUrl && !v.isShort);
  if (!videos.length) { sleep(2); return; }
  const v = videos[Math.floor(Math.random() * videos.length)];
  check(http.get(`${BASE}/watch?v=${v.id}`, { tags: { kind: 'page' } }), { 'watch 200': (r) => r.status === 200 });
  http.get(`${BASE}/api/videos/${v.id}`, { tags: { kind: 'api' } });
  http.get(`${BASE}/api/videos/${v.id}/next`, { tags: { kind: 'api' } });

  // Like a player: the master playlist, the lowest rung's playlist, then a few segments.
  const master = http.get(v.playbackUrl.startsWith('http') ? v.playbackUrl : `${BASE}${v.playbackUrl}`, { tags: { kind: 'media' } });
  const lines = (master.body || '').split('\n').filter((l) => l && !l.startsWith('#'));
  if (lines.length) {
    const base = master.url.slice(0, master.url.lastIndexOf('/') + 1);
    const variant = http.get(base + lines[lines.length - 1], { tags: { kind: 'media' } });
    const vbase = variant.url.slice(0, variant.url.lastIndexOf('/') + 1);
    const segs = (variant.body || '').split('\n').filter((l) => l && !l.startsWith('#')).slice(0, 3);
    for (const s of segs) { http.get(vbase + s, { tags: { kind: 'media' } }); sleep(2); }
  }
  http.post(`${BASE}/api/videos/${v.id}/views`, JSON.stringify({ watchedSeconds: 30 }), { headers: { 'content-type': 'application/json', origin: BASE }, tags: { kind: 'api' } });
  sleep(Math.random() * 5 + 3);
}
