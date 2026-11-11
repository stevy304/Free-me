# Pilot capacity and spending

Run `npm run plan:capacity -- deploy/capacity.pilot.json` from the repository root.
Copy the JSON to make a separate scenario and replace every price with your actual quote.
The example is an illustrative budget, not a provider quotation or a claim that the pilot has been deployed.

The calculator reports delivery volume, average and peak concurrency, peak delivered bandwidth,
monthly costs, contingency, and cost per watched hour. Decimal GB and a 30-day month are used.
Ten viewing hours at 2 Mbps require approximately 9 GB per user per month, excluding protocol overhead.
`averageMbps` is the delivered average across viewers, not the source upload bitrate.

The pilot example totals $567.50/month including 25% contingency. It assumes only 100 GPU hours,
5 TB of stored media, and a flat delivery rate of $0.005/GB. The storage figure must include all copies
you pay for: originals, renditions, recordings, and backups. It does not include creator payouts, taxes,
payment fees, marketing, hardware, or staff unless you explicitly add staff to `operationsUsd`.
Origin egress and provider tier minimums need to be added to the applicable cost inputs.

For larger scenarios, do not extrapolate server or GPU allowances unchanged. Enter benchmarked GPU
hours, the storage accumulated over time, server capacity, and negotiated delivery rates. A linear
delivery estimate cannot model CDN geography, cache performance, peak network limits, or live mixing.
The calculated bandwidth is viewer delivery demand, not necessarily origin bandwidth behind a CDN.

## Validate before buying capacity

1. Use the existing `npm run bench:video` harness against a staging deployment with phone, HD, and 4K
   fixtures. Follow its required `BENCH_COOKIE`, log, and origin settings; keep credentials out of Git.
2. Record upload success, retries, queue wait, first playable time, all-quality completion time, and
   playback startup/buffering on actual target networks. Measure CPU/GPU usage and scratch disk growth.
3. Run `deploy/loadtest/watch.js` only against your own staging service. Compare peak concurrency with
   the scenario, and monitor API/database latency, errors, origin traffic, and CDN cache hits.
4. Configure provider spending alerts and limits separately. This calculator does not enforce a budget.
5. Restore a backup in staging using `BACKUP-AND-RECOVERY.md` and verify the restored video can play.

## Current verification boundary

Local calculator and subprocess cancellation tests exercise arithmetic and encoder lifecycle behavior.
They do not establish a supported user count. Real encoding throughput, database load, CDN behavior,
failover, mobile network playback, and paid infrastructure require staging measurements.

Cancellation now waits for the encoder to close before scratch cleanup and lease release; a child
that ignores SIGTERM receives SIGKILL after five seconds. This covers the direct encoder process,
so custom executable wrappers must forward signals and manage their own descendants.
