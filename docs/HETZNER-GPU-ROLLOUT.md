# Hetzner + NVIDIA rollout

This is a pilot deployment recommendation, not a 100-million-user capacity claim.

## Initial hardware

Start with one AX102-class Hetzner application host: Ryzen 9 7950X3D,
128 GB ECC RAM and two 1.92 TB enterprise NVMe drives. Verify the current
configuration and quote before ordering. Mirror the drives for host availability;
RAID is not a backup. Keep the video library in separate S3-compatible object
storage with an independently tested backup/recovery policy. The host can run the
application, PostgreSQL and Redis for a limited pilot; this is a single failure
domain. Move the database to its own host before availability or measured load
requires it. Do not order an entire fleet before benchmarking real traffic.

Rent one NVIDIA L4 worker initially, with 8–16 vCPU, 32–64 GB RAM and at least
200 GB scratch space for small test files. Size scratch for all concurrent source
files, encoded outputs, chunk files and recovery headroom before enabling large
uploads: 100 GB inputs can exhaust this pilot configuration. L4 provides NVENC;
an expensive AI GPU is not automatically a suitable video encoder. Check the
NVIDIA codec support matrix and benchmark your actual source codecs.

GPU rental accelerates encoding, not the user's Internet upload. Current filters
(scale and HDR tone mapping) still execute on CPU; this implementation does not
claim a fully GPU-resident decode/filter/encode pipeline. Budget for transferring
source and output data between the GPU provider and Hetzner, and for GPU idle time.

References:
- https://docs.hetzner.com/robot/dedicated-server/dedicated-server-hardware/minimum-hardware-configuration/
- https://docs.hetzner.com/robot/general/traffic/
- https://developer.nvidia.com/video-codec-sdk
- https://developer.nvidia.com/video-encode-decode-support-matrix

## Worker configuration

Use the existing production environment template, including the same database,
Redis, S3 bucket and QUEUE_PREFIX on all workers. For the NVIDIA worker:

```dotenv
VIDEO_ENCODER=nvenc
WORKER_CONCURRENCY=1
WORKER_UPGRADE_CONCURRENCY=1
CHUNK_CONCURRENCY=1
CHUNKED_ENCODING=true
CHUNK_SECONDS=30
SCRATCH_DIR=/var/lib/freeme/scratch
NODE_NAME=gpu-worker-01
```

Use VIDEO_ENCODER=libx264 on CPU workers. Give every node a unique NODE_NAME
(or a unique hostname). Run workers using the existing worker service/command.
Install NVIDIA drivers and an FFmpeg build with h264_nvenc, then confirm the
rental exposes the GPU and permits video encoding. Startup performs an actual
one-frame encode with a 15-second timeout; a broken accelerator stops startup
before accepting jobs. No GPU is rented or configured by this change.

Keep database and Redis behind authenticated private networking/VPN. Never expose
them publicly to attach the rental. Workers currently need database and storage
access and also run maintenance tasks; these are not isolated sandbox workers.

CPU chunks use media-chunks; NVIDIA chunks use media-chunks-nvenc; Intel chunks
use media-chunks-qsv. Routing uses the actual encoding command, so a CPU fallback
returns to the CPU queue. GPU workers also consume CPU chunks for fallback. Each
queue has CHUNK_CONCURRENCY slots; GPU nodes therefore have up to twice that
number of chunk slots, in addition to foreground/background jobs. Start low and
measure GPU sessions, CPU and scratch usage before increasing concurrency.

Drain old processing jobs and stop every old worker before deploying this change
to all nodes. Old workers still consume the former shared queue and can enqueue
hardware commands there. Do not run mixed software versions during the transition.
Keep at least one compatible worker online for every encoder used by producers;
otherwise those jobs wait. Loss of a GPU fleet is not automatic rerouting to CPU.

## Evidence required before expanding

1. Upload and play a real 1080p clip and a real 4K clip, including seek and audio.
2. Confirm first-playable output appears before HD/4K upgrades complete.
3. Test portrait, variable frame rate, HDR and unsupported/corrupt sources.
4. Kill a worker mid-encode; verify retry and no duplicate or missing renditions.
5. Benchmark a mixed CPU/GPU fleet with shared Redis and S3, checking queue routing.
6. Measure upload throughput, queue wait, time to first playback, encoding throughput,
   startup delay, buffering, peak connections and cost per watched hour.
7. Restore the database and sample videos from backup onto a clean host.
8. Run staged playback/load tests, especially from Rwanda/mobile networks, and
   add delivery capacity based on measured peak bandwidth rather than account count.

## Honest assessment

This patch improves mixed CPU/GPU scheduling and detects unusable hardware at
startup. It does not establish production capacity, successful 4K GPU encoding,
failover, or readiness for 100 million monthly active users. Unit checks cover
routing, cancellation and preflight behavior. A real GPU, Redis/S3 fleet, database
and realistic load tests are required to validate the deployment.

Provisional engineering assessment: 5/10 for a pilot foundation, 2/10 for proven
100-million-monthly-active-user readiness. These are qualitative judgments, not
probabilities or benchmark results. No baseline increase is claimed because there
was no measured baseline deployment.
