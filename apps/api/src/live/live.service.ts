import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { LiveStream, User } from '@prisma/client';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../database/redis.service';
import { MediaQueue, STORAGE } from '../media/queue';
import type { Storage } from '../media/storage';
import { publish, room } from '../realtime/publish';
import { pushTo } from '../push/push';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { endLive, finishLive, LiveSync } from './sync';
import { encoderPlaylist } from './encoder-playlist';
import { ingestHealth, type IngestSample } from './ingest-health';
import { privateLivePrefix } from './sync';
import { browserLiveArgs } from './browser-hls';

export class LiveError extends Error {}
import { hasPremiumAccess } from '../billing/billing';
export const newStreamKey = () => `fm_${randomBytes(18).toString('base64url')}`;

const RECONNECT_MS = 30_000;

interface BrowserSession {
  ff: ChildProcess;
  ownerId: string;
  resumeKey: string;
  socketId: string;
  nextSequence: number;
  reconnect: { deadline: number; timer: NodeJS.Timeout } | null;
  stopping: boolean;
  ended: Promise<void>;
}

/**
 * Live streams. Browser streams arrive over the socket (MediaRecorder chunks) and are encoded here by ffmpeg into
 * HLS; OBS and TV encoders publish to nginx-rtmp, which writes HLS that the worker copies. Either way viewers get
 * HLS from the CDN, chat and a viewer count over the socket, and the recording becomes a video afterwards.
 */
/** A live poll as viewers see it. */
export interface LivePoll { id: string; question: string; options: string[]; votes: number[]; total: number; open: boolean; startedAt: string }
const pollKey = (streamId: string) => `fm:live:poll:${streamId}`;
const POLL_TTL = 6 * 3600;

@Injectable()
export class LiveService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Live');
  private readonly starting = new Set<string>();
  private readonly browser = new Map<string, BrowserSession>();
  private viewersTimer: NodeJS.Timeout | null = null;
  private readonly chat = new Map<string, unknown[]>();
  /** Polls without Redis (development): votes kept in this process. */
  private readonly memoryPolls = new Map<string, { poll: LivePoll; voters: Set<string> }>();
  private readonly pollPushes = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly prisma: PrismaService, @Inject(APP_CONFIG) private readonly config: AppConfig, @Inject(STORAGE) private readonly storage: Storage,
    private readonly queue: MediaQueue, private readonly realtime: RealtimeGateway, private readonly redis: RedisService,
  ) {}

  onModuleInit() {
    // Every 5 seconds: how many people watch each live stream (all servers), for the badge and the peak.
    this.viewersTimer = setInterval(() => { void this.countViewers(); }, 5000);
    this.viewersTimer.unref();
  }

  private async countViewers() {
    const live = await this.prisma.liveStream.findMany({ where: { status: 'LIVE' }, select: { id: true, peakViewers: true } }).catch(() => []);
    for (const s of live) {
      const n = await this.realtime.count(room.live(s.id)).catch(() => 0);
      publish(room.live(s.id), 'viewers', { count: n });
      const session = this.browser.get(s.id);
      if (session && !session.stopping) this.publishSignal(s.id, session);
      if (n > s.peakViewers) await this.prisma.liveStream.update({ where: { id: s.id }, data: { peakViewers: n } }).catch(() => undefined);
    }
  }

  async viewers(id: string) { return this.realtime.count(room.live(id)).catch(() => 0); }

  /** The creator's stream: the current one, or a new idle one ready to go live. */
  async mine(userId: string): Promise<LiveStream> {
    const ch = await this.prisma.channel.findUnique({ where: { userId } });
    if (!ch) throw new LiveError('Create your Space first.');
    return this.prisma.$transaction(async (tx) => {
      // Serialize creation across API processes; opening two studio tabs must not create competing streams.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ch.id}, 0))`;
      const active = await tx.liveStream.findFirst({ where: { channelId: ch.id, status: { in: ['LIVE', 'PREVIEW'] } }, orderBy: { createdAt: 'desc' } });
      const cur = active ?? await tx.liveStream.findFirst({ where: { channelId: ch.id, status: 'IDLE' }, orderBy: { createdAt: 'desc' } });
      return cur ?? tx.liveStream.create({ data: { channelId: ch.id, title: `${ch.name} live` } });
    });
  }

  /** The Space's encoder key (made the first time it is asked for; it stays the same between streams). */
  async streamKey(userId: string, reset = false) {
    const ch = await this.prisma.channel.findUniqueOrThrow({ where: { userId } });
    if (ch.liveStreamKey && !reset) return ch.liveStreamKey;
    if (reset && await this.prisma.liveStream.findFirst({ where: { channelId: ch.id, status: { in: ['PREVIEW', 'LIVE'] }, source: 'rtmp' }, select: { id: true } })) {
      throw new LiveError('Stop your encoder before replacing its stream key.');
    }
    const key = newStreamKey();
    // Concurrent studio requests must receive the same initial key.
    await this.prisma.channel.updateMany({ where: { id: ch.id, ...(reset ? {} : { liveStreamKey: null }) }, data: { liveStreamKey: key } });
    return (await this.prisma.channel.findUniqueOrThrow({ where: { id: ch.id } })).liveStreamKey!;
  }

  /** Followers hear that the Space is live (once per stream). */
  private async announce(s: LiveStream) {
    if (s.visibility !== 'PUBLIC') return;
    const ch = await this.prisma.channel.findUniqueOrThrow({ where: { id: s.channelId } });
    const followers = await this.prisma.subscription.findMany({ where: { channelId: ch.id }, select: { userId: true } });
    const to = followers.filter((f) => f.userId !== ch.userId);
    if (to.length) await this.prisma.notification.createMany({ data: to.map((f) => ({ userId: f.userId, type: 'LIVE' as const, actorId: ch.userId, liveStreamId: s.id })) });
    for (const f of to) publish(room.user(f.userId), 'notifications');
    pushTo(to.map((f) => f.userId), { title: `${ch.name} is live`, body: s.title, url: `/live/${s.id}`, tag: `live-${s.id}` });
  }

  async previewEncoder(user: User, streamId: string) {
    if (user.status !== 'ACTIVE' || !hasPremiumAccess(user)) throw new LiveError('Live Studio is part of Premium.');
    const result = await this.prisma.liveStream.updateMany({ where: { id: streamId, status: 'IDLE', channel: { userId: user.id } }, data: {
      status: 'PREVIEW', source: 'rtmp', encoderConnectedAt: new Date(), encoderHeartbeatAt: new Date(),
    } });
    if (!result.count) throw new LiveError('A broadcast is already connected. Stop it before connecting another encoder.');
  }

  async publishEncoder(user: User, streamId: string) {
    if (user.status !== 'ACTIVE' || !hasPremiumAccess(user)) throw new LiveError('Live Studio is part of Premium.');
    const s = await this.prisma.liveStream.findFirst({ where: { id: streamId, source: 'rtmp', status: 'PREVIEW', channel: { userId: user.id } } });
    if (!s) throw new LiveError('Connect your encoder to a private preview first.');
    const health = ingestHealth(s.ingestHealth as unknown as IngestSample | null, s.encoderHeartbeatAt, true);
    if (!health.ready) throw new LiveError('Wait for a fresh, playable H.264 encoder signal before going live.');
    const text = await this.storage.getText(privateLivePrefix(s.id) + 'index.m3u8');
    if (!text) throw new LiveError('The private preview is not ready yet.');
    const parsed = encoderPlaylist(text);
    if (!parsed.segments.length) throw new LiveError('Wait for the first video segment.');
    const result = await this.prisma.liveStream.updateMany({ where: { id: s.id, status: 'PREVIEW' }, data: {
      status: 'LIVE', startedAt: new Date(), encoderStartSequence: null,
    } });
    if (!result.count) throw new LiveError('The preview changed. Refresh the studio and try again.');
    const live = await this.prisma.liveStream.findUniqueOrThrow({ where: { id: s.id } });
    await this.announce(live).catch((e) => this.log.warn(`Live notice ${s.id}: ${(e as Error).message}`));
    publish(room.live(s.id), 'started', { id: s.id });
  }

  /** Starts a browser broadcast or a Premium encoder broadcast. */
  async goLive(user: User, streamId: string, source: 'browser' | 'rtmp') {
    if (source === 'rtmp' && !hasPremiumAccess(user)) throw new LiveError('Live Studio is part of Premium.');
    const s = await this.prisma.liveStream.findUnique({ where: { id: streamId }, include: { channel: true } });
    if (!s || s.channel.userId !== user.id) throw new LiveError('Stream not found.');
    if (s.status === 'ENDED') throw new LiveError('This stream has ended. Start a new one.');
    const started = await this.prisma.liveStream.updateMany({ where: { id: s.id, status: 'IDLE' }, data: { status: 'LIVE', source, startedAt: new Date() } });
    if (!started.count) throw new LiveError('This stream is already running.');
    const updated = await this.prisma.liveStream.findUniqueOrThrow({ where: { id: s.id } });
    await this.announce(updated).catch((error) => this.log.warn(`Live notice ${s.id}: ${(error as Error).message}`));
    publish(room.live(s.id), 'started', { id: s.id });
    return updated;
  }

  // ----- Browser streams -----

  async startBrowser(user: User, streamId: string, socketId: string) {
    if (this.browser.has(streamId) || this.starting.has(streamId)) throw new LiveError('This stream is already running in another window.');
    if (this.browser.size + this.starting.size >= this.config.live.browserLimit) throw new LiveError('All browser streaming slots are busy. Try again shortly.');
    this.starting.add(streamId);
    try {
      const dir = join(this.config.media.scratchDir, 'live', streamId);
      // Prepare the scratch directory only for the owner's stream.
      const stream = await this.prisma.liveStream.findFirst({ where: { id: streamId, channel: { userId: user.id } }, select: { id: true } });
      if (!stream) throw new LiveError('Stream not found.');
      await mkdir(dir, { recursive: true });
      const s = await this.goLive(user, streamId, 'browser');
      const ff = spawn(this.config.media.ffmpegPath, browserLiveArgs(dir, s.latencyMode === 'low' ? 1 : 2), { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      ff.on('error', (error) => { err = error.message; });
      ff.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
      ff.stdin?.on('error', () => undefined);
      const sync = new LiveSync(this.storage, s.id, dir, 'browser');
      const timer = setInterval(() => { void sync.tick().catch((e) => this.log.warn(`live ${s.id}: ${(e as Error).message}`)); }, 1000);
      const resumeKey = randomBytes(24).toString('base64url');
      const ended = new Promise<void>((resolve) => ff.on('close', async (code) => {
        clearInterval(timer);
        const reconnect = this.browser.get(s.id)?.reconnect;
        if (reconnect) clearTimeout(reconnect.timer);
        this.browser.delete(s.id);
        if (code) this.log.warn(`live ${s.id}: encoder stopped (${code}): ${err.trim().slice(-500)}`);
        try {
          await endLive(this.prisma, s.id);
          await finishLive(this.prisma, this.storage, sync, (videoId) => this.queue.add({ name: 'transcode', videoId }), this.log, this.config.media.ffmpegPath);
        } catch (error) {
          this.log.warn(`Could not finish stream ${s.id}: ${(error as Error).message}`);
        } finally { resolve(); }
      }));
      this.browser.set(s.id, { ff, ownerId: user.id, resumeKey, socketId, nextSequence: 0, reconnect: null, stopping: false, ended });
      return { id: s.id, resumeKey, reconnectMs: RECONNECT_MS };
    } finally { this.starting.delete(streamId); }
  }

  private publishSignal(id: string, session: BrowserSession) {
    publish(room.live(id), 'live:signal', { reconnectUntil: session.reconnect?.deadline ?? null });
  }

  resumeBrowser(userId: string, streamId: string, socketId: string, key: string) {
    const session = this.browser.get(streamId);
    if (!session || session.ownerId !== userId || session.resumeKey !== key || session.stopping) return false;
    if (session.reconnect) {
      if (Date.now() >= session.reconnect.deadline) return false;
      clearTimeout(session.reconnect.timer);
      session.reconnect = null;
      session.socketId = socketId;
      this.publishSignal(streamId, session);
    }
    return session.socketId === socketId;
  }

  /** A repeated sequence means the encoder got the data but the acknowledgement was lost. */
  chunk(streamId: string, socketId: string, sequence: number, data: Buffer) {
    const b = this.browser.get(streamId);
    if (!b || b.socketId !== socketId || b.reconnect || b.stopping) return { ok: false };
    if (sequence < b.nextSequence) return { ok: true };
    const stdin = b.ff.stdin;
    if (sequence !== b.nextSequence || !stdin?.writable) return { ok: false };
    if (stdin.writableLength + data.length > 8 * 1024 * 1024) return { ok: false, retry: true };
    stdin.write(data);
    b.nextSequence += 1;
    return { ok: true };
  }

  /** Finishes the encoder and saves the replay once, even if end and expiry race. */
  async stopBrowser(streamId: string, socketId?: string) {
    const b = this.browser.get(streamId);
    if (!b || (socketId && b.socketId !== socketId)) return false;
    if (b.stopping) { await b.ended; return true; }
    b.stopping = true;
    if (b.reconnect) clearTimeout(b.reconnect.timer);
    b.ff.stdin?.end();
    const kill = setTimeout(() => b.ff.kill('SIGKILL'), 20_000);
    await b.ended;
    clearTimeout(kill);
    return true;
  }

  dropSocket(socketId: string) {
    for (const [id, b] of this.browser) {
      if (b.socketId !== socketId || b.stopping || b.reconnect) continue;
      const timer = setTimeout(() => { void this.stopBrowser(id); }, RECONNECT_MS);
      b.reconnect = { deadline: Date.now() + RECONNECT_MS, timer };
      this.publishSignal(id, b);
    }
  }

  // ----- Chat -----

  /** Recent chat for people who just arrived (kept 2 hours, last 50 lines). */
  async recentChat(id: string): Promise<unknown[]> {
    const r = this.redis.client;
    if (r) return (await r.lrange(`fm:live:chat:${id}`, 0, 49)).map((x) => JSON.parse(x)).reverse();
    return [...(this.chat.get(id) ?? [])];
  }

  async say(id: string, line: object) {
    const r = this.redis.client;
    if (r) await r.multi().lpush(`fm:live:chat:${id}`, JSON.stringify(line)).ltrim(`fm:live:chat:${id}`, 0, 49).expire(`fm:live:chat:${id}`, 7200).exec();
    else { const l = this.chat.get(id) ?? []; l.push(line); this.chat.set(id, l.slice(-50)); }
    publish(room.live(id), 'chat', line);
  }

  // ----- Polls -----

  /**
   * The stream's poll (at most one at a time): the question, its answers, the votes so far and whether voting is open.
   * Kept in Redis for 6 hours, so every API server sees the same votes; one vote per account (a Redis set).
   */
  async poll(streamId: string): Promise<LivePoll | null> {
    const r = this.redis.client;
    if (!r) return this.memoryPolls.get(streamId)?.poll ?? null;
    const raw = await r.get(pollKey(streamId));
    if (!raw) return null;
    const p = JSON.parse(raw) as Omit<LivePoll, 'votes' | 'total'>;
    const counts = await r.hgetall(`${pollKey(streamId)}:${p.id}:votes`);
    const votes = p.options.map((_, i) => Number(counts[i] ?? 0));
    return { ...p, votes, total: votes.reduce((a, b) => a + b, 0) };
  }

  /** The host asks a question with 2 to 4 answers; it replaces any earlier poll. */
  async startPoll(streamId: string, question: string, options: string[]) {
    const p = { id: randomUUID(), question, options, open: true, startedAt: new Date().toISOString() };
    const r = this.redis.client;
    if (r) await r.set(pollKey(streamId), JSON.stringify(p), 'EX', POLL_TTL);
    else this.memoryPolls.set(streamId, { poll: { ...p, votes: options.map(() => 0), total: 0 }, voters: new Set() });
    const poll = await this.poll(streamId);
    publish(room.live(streamId), 'poll', { poll });
    return poll;
  }

  /** One vote per account per poll; returns the results (null if there is no open poll with that id and answer). */
  async vote(streamId: string, pollId: string, userId: string, option: number): Promise<{ poll: LivePoll; counted: boolean } | null> {
    const current = await this.poll(streamId);
    if (!current || current.id !== pollId || !current.open || !Number.isInteger(option) || option < 0 || option >= current.options.length) return null;
    const r = this.redis.client;
    let counted: boolean;
    if (r) {
      counted = (await r.sadd(`${pollKey(streamId)}:${pollId}:voters`, userId)) === 1;
      if (counted) await r.multi().hincrby(`${pollKey(streamId)}:${pollId}:votes`, String(option), 1)
        .expire(`${pollKey(streamId)}:${pollId}:votes`, POLL_TTL).expire(`${pollKey(streamId)}:${pollId}:voters`, POLL_TTL).exec();
    } else {
      const m = this.memoryPolls.get(streamId)!;
      counted = !m.voters.has(userId);
      if (counted) { m.voters.add(userId); m.poll.votes[option]++; m.poll.total++; }
    }
    // Results go out at most four times a second, however fast votes arrive.
    if (counted && !this.pollPushes.has(streamId)) {
      this.pollPushes.set(streamId, setTimeout(() => { this.pollPushes.delete(streamId); this.poll(streamId).then((p) => publish(room.live(streamId), 'poll', { poll: p })).catch(() => undefined); }, 250));
    }
    return { poll: (await this.poll(streamId))!, counted };
  }

  /** The host ends voting; the results stay on screen until the next poll or the end of the stream. */
  async closePoll(streamId: string) {
    const r = this.redis.client;
    const current = await this.poll(streamId);
    if (!current) return null;
    if (r) await r.set(pollKey(streamId), JSON.stringify({ id: current.id, question: current.question, options: current.options, open: false, startedAt: current.startedAt }), 'EX', POLL_TTL);
    else this.memoryPolls.get(streamId)!.poll.open = false;
    const poll = await this.poll(streamId);
    publish(room.live(streamId), 'poll', { poll });
    return poll;
  }

  async onModuleDestroy() {
    // Results waiting to be sent go nowhere once the server stops (Redis is closing).
    for (const t of this.pollPushes.values()) clearTimeout(t);
    this.pollPushes.clear();
    if (this.viewersTimer) clearInterval(this.viewersTimer);
    await Promise.allSettled([...this.browser.keys()].map((id) => this.stopBrowser(id)));
  }
}
