#!/usr/bin/env node
// The load of people *watching* (not browsing): what every playing video sends to the API. A signed-in viewer's
// player saves the resume position every 15 s, reports watch time about every minute and the view once; anyone's
// player also reports playback health. At 1 million people watching at once that is roughly 70,000 requests per
// second, all small, nearly all writes, so this is the path that has to scale with viewers.
//
//   SESSIONS=sessions.txt node deploy/loadtest/player-bench.mjs http://127.0.0.1:4000 200 30
//
// SESSIONS: a file with one session token per line (deploy/loadtest/make-sessions.mjs makes test accounts and
// sessions on a test database). Each simulated player is a random account on a random address
// (X-Forwarded-For, honoured when the API runs with TRUST_PROXY=1), like real viewers, so per-account and
// per-address limits behave as in production. Never run it against production: it writes watch history.
import { readFileSync } from 'node:fs';

const [base = 'http://127.0.0.1:4000', concurrencyArg = '100', secondsArg = '30'] = process.argv.slice(2);
const concurrency = Math.max(1, Number(concurrencyArg));
const seconds = Math.max(5, Number(secondsArg));
const api = base.replace(/\/+$/, '');
const tokens = readFileSync(process.env.SESSIONS ?? 'sessions.txt', 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const cookie = process.env.SESSION_COOKIE ?? 'fm_session';
if (!tokens.length) { console.error('No sessions: run make-sessions.mjs first.'); process.exit(2); }

const list = await (await fetch(`${api}/api/videos?limit=48`)).json();
const ids = (list.videos ?? []).filter((v) => v.durationSeconds >= 30).map((v) => v.id);
if (!ids.length) { console.error('No public videos of 30 s or more: publish some first.'); process.exit(2); }
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

// Per minute of watching: 4 resume saves, 1 watch-time report; a view and a health report now and then.
const steps = [
  { name: 'progress', weight: 8, req: (id) => [`/api/videos/${id}/progress`, { seconds: 10 + Math.floor(Math.random() * 20) }] },
  { name: 'watch', weight: 2, req: (id) => [`/api/videos/${id}/watch`, { watchedSeconds: 60 }] },
  { name: 'view', weight: 1, req: (id) => [`/api/videos/${id}/views`, { watchedSeconds: 30 }] },
  { name: 'health', weight: 1, req: () => [`/api/videos/${pick(ids)}/playback-health`, { kind: 'startup', durationMs: 400 + Math.floor(Math.random() * 900) }] },
];
const bag = steps.flatMap((s) => Array(s.weight).fill(s));
const stats = new Map(steps.map((s) => [s.name, { ms: [], errors: 0, codes: {} }]));

const until = Date.now() + seconds * 1000;
async function viewer() {
  // A player stays on one video with one account for a while (here 40 reports), then another viewer takes its place.
  let left = 0; let me = ''; let video = ''; let from = '';
  while (Date.now() < until) {
    if (left-- <= 0) { left = 40; me = pick(tokens); video = pick(ids); from = ip(); }
    const s = pick(bag);
    const st = stats.get(s.name);
    const [path, body] = s.req(video);
    const t = performance.now();
    try {
      const r = await fetch(api + path, { method: 'POST', body: JSON.stringify(body), headers: {
        'content-type': 'application/json', origin: process.env.ORIGIN ?? 'http://localhost:3000', 'x-forwarded-for': from, cookie: `${cookie}=${me}` } });
      await r.arrayBuffer();
      if (r.status >= 400) { st.errors++; st.codes[r.status] = (st.codes[r.status] ?? 0) + 1; }
    } catch { st.errors++; }
    st.ms.push(performance.now() - t);
  }
}
console.log(`${concurrency} players at once for ${seconds} s against ${api}, ${tokens.length} accounts, ${ids.length} videos …`);
await Promise.all(Array.from({ length: concurrency }, viewer));

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const all = []; let errors = 0;
console.log('endpoint   requests   req/s    p50 ms   p95 ms   p99 ms   errors');
for (const [name, st] of stats) {
  all.push(...st.ms); errors += st.errors;
  console.log(`${name.padEnd(10)} ${String(st.ms.length).padStart(8)} ${(st.ms.length / seconds).toFixed(1).padStart(8)} ${pct(st.ms, 50).toFixed(0).padStart(8)} ${pct(st.ms, 95).toFixed(0).padStart(8)} ${pct(st.ms, 99).toFixed(0).padStart(8)} ${String(st.errors).padStart(8)}${Object.keys(st.codes).length ? ` ${JSON.stringify(st.codes)}` : ''}`);
}
console.log(`${'total'.padEnd(10)} ${String(all.length).padStart(8)} ${(all.length / seconds).toFixed(1).padStart(8)} ${pct(all, 50).toFixed(0).padStart(8)} ${pct(all, 95).toFixed(0).padStart(8)} ${pct(all, 99).toFixed(0).padStart(8)} ${String(errors).padStart(8)}`);
process.exit(errors / Math.max(1, all.length) > 0.01 ? 1 : 0);
