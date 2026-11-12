#!/usr/bin/env node
// API load test with nothing to install (Node 22's own fetch). It measures how many requests per second the API
// answers, and how fast, on the pages people open most: home, the video list, a watch page, Next and search.
// Video files come from the CDN, so they are not part of this test (deploy/loadtest/watch.js with k6 covers them).
//
//   node deploy/loadtest/api-bench.mjs https://freeme.example 50 60     # 50 at once for 60 seconds
//   node deploy/loadtest/api-bench.mjs http://127.0.0.1:4000 200 30     # straight to one API process
//
// Run it from a machine outside your servers for real numbers. It prints one line per endpoint and a total, and
// exits with 1 if more than 1% of requests failed or 95% of them took longer than 800 ms.

const [base = 'http://127.0.0.1:4000', concurrencyArg = '50', secondsArg = '30'] = process.argv.slice(2);
const concurrency = Math.max(1, Number(concurrencyArg));
const seconds = Math.max(5, Number(secondsArg));
const api = base.replace(/\/+$/, '');

async function json(path) {
  const r = await fetch(api + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

const list = await json('/api/videos?limit=24');
const ids = (list.videos ?? []).map((v) => v.id);
if (!ids.length) { console.error('No public videos: publish some first.'); process.exit(2); }
const words = (list.videos ?? []).flatMap((v) => v.title.split(/\s+/)).filter((w) => w.length > 3).slice(0, 20);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

/** What one visitor does, weighted like real traffic: most people browse and watch, fewer search. */
const steps = [
  { name: 'home', weight: 3, path: () => '/api/feed/home' },
  { name: 'videos', weight: 2, path: () => '/api/videos?limit=24' },
  { name: 'watch', weight: 4, path: () => `/api/videos/${pick(ids)}` },
  { name: 'next', weight: 3, path: () => `/api/videos/${pick(ids)}/next` },
  { name: 'rising', weight: 1, path: () => '/api/feed/rising' },
  { name: 'search', weight: 1, path: () => `/api/search?q=${encodeURIComponent(pick(words) ?? 'video')}` },
];
const bag = steps.flatMap((s) => Array(s.weight).fill(s));
const stats = new Map(steps.map((s) => [s.name, { ms: [], errors: 0 }]));

const until = Date.now() + seconds * 1000;
async function visitor() {
  while (Date.now() < until) {
    const s = pick(bag);
    const st = stats.get(s.name);
    const t = performance.now();
    try {
      const r = await fetch(api + s.path());
      await r.arrayBuffer();
      if (r.status >= 500 || r.status === 429) st.errors++;
    } catch { st.errors++; }
    st.ms.push(performance.now() - t);
  }
}
console.log(`${concurrency} at once for ${seconds} s against ${api} …`);
await Promise.all(Array.from({ length: concurrency }, visitor));

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const all = []; let errors = 0;
console.log('endpoint   requests   req/s    p50 ms   p95 ms   p99 ms   errors');
for (const [name, st] of stats) {
  all.push(...st.ms); errors += st.errors;
  console.log(`${name.padEnd(10)} ${String(st.ms.length).padStart(8)} ${(st.ms.length / seconds).toFixed(1).padStart(8)} ${pct(st.ms, 50).toFixed(0).padStart(8)} ${pct(st.ms, 95).toFixed(0).padStart(8)} ${pct(st.ms, 99).toFixed(0).padStart(8)} ${String(st.errors).padStart(8)}`);
}
const p95 = pct(all, 95);
console.log(`${'total'.padEnd(10)} ${String(all.length).padStart(8)} ${(all.length / seconds).toFixed(1).padStart(8)} ${pct(all, 50).toFixed(0).padStart(8)} ${p95.toFixed(0).padStart(8)} ${pct(all, 99).toFixed(0).padStart(8)} ${String(errors).padStart(8)}`);
const failed = errors / Math.max(1, all.length) > 0.01 || p95 > 800;
console.log(failed ? 'FAILED: over 1% errors or p95 over 800 ms' : 'PASSED: under 1% errors and p95 under 800 ms');
process.exit(failed ? 1 : 0);
