import { Logger } from '@nestjs/common';
import type { Job, Queue, QueueEvents } from 'bullmq';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { run } from './probe';
import type { Storage } from './storage';

/**
 * Long videos are encoded in pieces (CHUNK_SECONDS each) that any worker server can take, so adding a server makes
 * a long video's qualities arrive sooner. The pieces are joined without re-encoding and cut into HLS segments.
 */
export const CHUNK_QUEUE = 'media-chunks';

/** First piece: keyframes at 0, 1, 2, 4, 6 … s (1 s first segment). Later pieces start on an even second: every 2 s. */
export const FIRST_KEYFRAMES = 'expr:if(lt(t,2),gte(t,n_forced),gte(t,(n_forced-1)*2))';
export const NEXT_KEYFRAMES = 'expr:gte(t,n_forced*2)';

export interface ChunkTask {
  videoId: string;
  /** One encoding pass; pieces of different passes never mix. */
  run: string;
  index: number;
  /** ffmpeg arguments; `{IN}` is the source, `{OUT:<rung>}` the piece of that rung. */
  args: string[];
  rungs: string[];
  /** The source on the server that planned the work (used when the piece runs there), else a signed link to storage. */
  source: { host: string; path: string; key: string };
  /** Pieces made on the planning server are written straight into its work folder; others go through storage. */
  out: { host: string; dir: string };
  /** Lower CPU priority for background work (higher qualities), so new uploads stay fast. */
  niceness: number;
}
export interface ChunkResult { index: number; remote: boolean }

/** This server's name: pieces made where the work was planned skip storage. NODE_NAME overrides it. */
export const nodeName = () => process.env.NODE_NAME?.trim() || hostname();

export const videoChunksPrefix = (videoId: string) => `tmp/chunks/${videoId}/`;
export const chunkPrefix = (videoId: string, runId: string) => `${videoChunksPrefix(videoId)}${runId}/`;
export const chunkKey = (videoId: string, runId: string, index: number, rung: string) => `${chunkPrefix(videoId, runId)}${index}/${rung}.mp4`;
export const chunkFile = (dir: string, index: number, rung: string) => join(dir, `${String(index).padStart(5, '0')}_${rung}.mp4`);

/** Encodes one piece. Runs on whichever worker took it. */
export async function runChunk(task: ChunkTask, deps: { ffmpegPath: string; storage: Storage; scratchDir: string }, signal?: AbortSignal): Promise<ChunkResult> {
  const here = nodeName();
  const input = task.source.host === here && existsSync(task.source.path) ? task.source.path : await deps.storage.signedGetUrl(task.source.key, 6 * 3600);
  const local = task.out.host === here && existsSync(task.out.dir);
  const dir = local ? task.out.dir : join(deps.scratchDir, 'chunks', `${task.videoId}-${task.run}-${task.index}`);
  await mkdir(dir, { recursive: true });
  try {
    const args = task.args.map((a) => (a === '{IN}' ? input : a.startsWith('{OUT:') ? chunkFile(dir, task.index, a.slice(5, -1)) : a));
    await run(deps.ffmpegPath, args, undefined, signal, task.niceness);
    if (!local) {
      for (const r of task.rungs) await deps.storage.putFile(chunkKey(task.videoId, task.run, task.index, r), chunkFile(dir, task.index, r), { contentType: 'video/mp4' });
    }
    return { index: task.index, remote: !local };
  } finally {
    if (!local) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Where pieces are encoded: this process (no Redis) or every worker through the queue. */
export interface ChunkRunner {
  runAll(tasks: ChunkTask[], onDone: (finished: number) => void, signal?: AbortSignal): Promise<ChunkResult[]>;
}

/** In this process, a few at a time (development, tests, a single machine without Redis). */
export class LocalChunks implements ChunkRunner {
  constructor(private readonly concurrency: number, private readonly deps: { ffmpegPath: string; storage: Storage; scratchDir: string }) {}
  async runAll(tasks: ChunkTask[], onDone: (finished: number) => void, signal?: AbortSignal) {
    const results: ChunkResult[] = [];
    let next = 0; let finished = 0;
    const abort = new AbortController();
    const runSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    await Promise.all(Array.from({ length: Math.min(this.concurrency, tasks.length) }, async () => {
      try {
        while (next < tasks.length) {
          runSignal.throwIfAborted();
          const t = tasks[next++];
          results[t.index] = await runChunk(t, this.deps, runSignal);
          onDone(++finished);
        }
      } catch (error) { abort.abort(error); }
    }));
    runSignal.throwIfAborted();
    return results;
  }
}

/** Through the chunk queue: every worker server (CHUNK_CONCURRENCY pieces each) takes pieces as it frees up. */
export class QueueChunks implements ChunkRunner {
  private readonly log = new Logger('Chunks');
  constructor(private readonly queue: Queue, private readonly events: QueueEvents) {}

  async runAll(tasks: ChunkTask[], onDone: (finished: number) => void, signal?: AbortSignal) {
    await this.events.waitUntilReady();
    const jobs: Job[] = await this.queue.addBulk(tasks.map((t) => ({
      name: 'chunk', data: t,
      opts: {
        jobId: `${t.videoId}-${t.run}-${t.index}`, attempts: 3, backoff: { type: 'exponential' as const, delay: 5_000 },
        // Pieces of a video someone is waiting to watch go before pieces of higher qualities.
        priority: t.niceness ? 10 : 1, removeOnComplete: { age: 3600 }, removeOnFail: { age: 24 * 3600 },
      },
    })));
    const cancel = () => { for (const j of jobs) void j.remove().catch(() => undefined); };
    signal?.addEventListener('abort', cancel, { once: true });
    let finished = 0;
    try {
      const aborted = new Promise<never>((_, reject) => {
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      aborted.catch(() => undefined); // an abort after the pieces are done is not an error here
      const all = Promise.all(jobs.map(async (j) => { const r = (await j.waitUntilFinished(this.events)) as ChunkResult; onDone(++finished); return r; }));
      all.catch(() => undefined); // after an abort nobody waits for it
      return await Promise.race([all, aborted]);
    } catch (e) {
      if (!signal?.aborted) this.log.warn(`pieces of ${tasks[0]?.videoId} failed: ${(e as Error).message.slice(0, 300)}`);
      cancel();
      throw e instanceof Error ? e : new Error(String(e));
    } finally { signal?.removeEventListener('abort', cancel); }
  }
}
