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
import { endLive, finishLive, LIVE_PLAYLIST, LiveSync } from './sync';

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
@Injectable()
export class LiveService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Live');
  private readonly starting = new Set<string>();
  private readonly browser = new Map<string, BrowserSession>();
  private viewersTimer: NodeJS.Timeout | null = null;
  private readonly chat = new Map<string, unknown[]>();
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
    const cur = await this.prisma.liveStream.findFirst({ where: { channelId: ch.id, status: { in: ['IDLE', 'LIVE'] } }, orderBy: { createdAt: 'desc' } });
    return cur ?? this.prisma.liveStream.create({ data: { channelId: ch.id, title: `${ch.name} live` } });
  }

  /** The Space's encoder key (made the first time it is asked for; it stays the same between streams). */
  async streamKey(userId: string, reset = false) {
    const ch = await this.prisma.channel.findUniqueOrThrow({ where: { userId } });
    if (ch.liveStreamKey && !reset) return ch.liveStreamKey;
    const key = newStreamKey();
    await this.prisma.channel.update({ where: { id: ch.id }, data: { liveStreamKey: key } });
    return key;
  }

  /** Followers hear that the Space is live (once per stream). */
  private async announce(s: LiveStream) {
    const ch = await this.prisma.channel.findUniqueOrThrow({ where: { id: s.channelId } });
    const followers = await this.prisma.subscription.findMany({ where: { channelId: ch.id }, select: { userId: true } });
    const to = followers.filter((f) => f.userId !== ch.userId);
    if (to.length) await this.prisma.notification.createMany({ data: to.map((f) => ({ userId: f.userId, type: 'LIVE' as const, actorId: ch.userId, liveStreamId: s.id })) });
    for (const f of to) publish(room.user(f.userId), 'notifications');
    pushTo(to.map((f) => f.userId), { title: `${ch.name} is live`, body: s.title, url: `/live/${s.id}`, tag: `live-${s.id}` });
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
      const ff = spawn(this.config.media.ffmpegPath, [
        // Start after about a second of input (by default ffmpeg first analyses 5 MB, seconds of delay for viewers).
        '-hide_banner', '-loglevel', 'error', '-probesize', '256k', '-analyzeduration', '1000000', '-fflags', '+genpts', '-i', 'pipe:0',
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
        '-vf', "scale='min(1280,iw)':-2", '-r', '30', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-b:v', '2500k', '-maxrate', '3000k', '-bufsize', '5000k',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
        '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments', '-hls_segment_filename', join(dir, 'seg%05d.ts'), join(dir, LIVE_PLAYLIST),
      ], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      ff.on('error', (error) => { err = error.message; });
      ff.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
      ff.stdin?.on('error', () => undefined);
      const sync = new LiveSync(this.storage, s.id, dir);
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

  async onModuleDestroy() {
    if (this.viewersTimer) clearInterval(this.viewersTimer);
    await Promise.allSettled([...this.browser.keys()].map((id) => this.stopBrowser(id)));
  }
}
