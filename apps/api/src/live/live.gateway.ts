import { ConnectedSocket, MessageBody, type OnGatewayDisconnect, type OnGatewayInit, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { PrismaService } from '../database/prisma.service';
import { RateLimitService } from '../common/rate-limit.service';
import { LiveGuests } from './live-guests';
import { LiveError, LiveService } from './live.service';
import { publish, room } from '../realtime/publish';

const ID = /^[0-9a-f-]{36}$/;
/** One line of plain text: no control characters, single spaces, at most `max` characters. */
const clean = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Live over the socket: a creator's browser sends its recording in one-second pieces; viewers chat.
 * (Same endpoint as RealtimeGateway, which signs the socket in and puts it in its rooms.)
 */
@WebSocketGateway({ path: '/api/socket', addTrailingSlash: false, serveClient: false, transports: ['websocket'], maxHttpBufferSize: 8 * 1024 * 1024 })
export class LiveGateway implements OnGatewayDisconnect, OnGatewayInit {
  private readonly guests = new LiveGuests();

  constructor(private readonly live: LiveService, private readonly prisma: PrismaService, private readonly limits: RateLimitService) {}

  afterInit(server: Server) {
    const namespace = server.of('/');
    namespace.on('freeme:guest-join', (id: string, userId: string, token: string, reply: (result: unknown) => void) => {
      if (!this.guests.hasInvite(token)) { reply(null); return; }
      reply(this.guests.join({
        id, data: { userId }, emit: (event, payload) => namespace.to(id).emit(event, payload),
      }, token));
    });
    namespace.on('freeme:guest-relay', (id: string, target: string, payload: unknown) => {
      this.guests.signal({ id, data: {}, emit: () => undefined }, target, payload);
    });
    namespace.on('freeme:guest-leave', (id: string) => {
      this.guests.leave({ id, data: {}, emit: () => undefined });
    });
  }

  private async user(socket: Socket) {
    const id = socket.data.userId as string | undefined;
    return id ? this.prisma.user.findUnique({ where: { id } }) : null;
  }

  @SubscribeMessage('live:start')
  async start(@ConnectedSocket() socket: Socket, @MessageBody() streamId: unknown) {
    const u = await this.user(socket);
    if (!u || u.status !== 'ACTIVE') return { ok: false, error: 'Sign in to go live.' };
    if (typeof streamId !== 'string' || !ID.test(streamId)) return { ok: false, error: 'Stream not found.' };
    try {
      const session = await this.live.startBrowser(u, streamId, socket.id);
      if (!socket.connected) this.live.dropSocket(socket.id);
      return { ok: true, ...session };
    }
    catch (e) { return { ok: false, error: e instanceof LiveError ? e.message : 'The stream could not start.' }; }
  }

  @SubscribeMessage('live:resume')
  async resume(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const [streamId, key] = Array.isArray(body) ? body : [];
    if (typeof streamId !== 'string' || !ID.test(streamId) || typeof key !== 'string' || key.length !== 32) return { ok: false };
    const user = await this.user(socket);
    return { ok: !!(socket.connected && user?.status === 'ACTIVE' && this.live.resumeBrowser(user.id, streamId, socket.id, key)) };
  }

  @SubscribeMessage('live:chunk')
  chunk(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const [streamId, sequence, data] = Array.isArray(body) ? body : [];
    if (typeof streamId !== 'string' || !Number.isSafeInteger(sequence) || sequence < 0 || !Buffer.isBuffer(data) || !data.length) return { ok: false };
    return this.live.chunk(streamId, socket.id, sequence, data);
  }

  @SubscribeMessage('live:stop')
  async stop(@ConnectedSocket() socket: Socket, @MessageBody() streamId: unknown) {
    if (typeof streamId !== 'string') return { ok: false };
    return { ok: await this.live.stopBrowser(streamId, socket.id) };
  }

  @SubscribeMessage('live:guest-open')
  async openGuests(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const { streamId: id, basic } = (body ?? {}) as { streamId?: unknown; basic?: unknown };
    const user = await this.user(socket);
    if (!socket.connected || socket.data.guestHost || socket.data.guestJoining || user?.status !== 'ACTIVE' || typeof id !== 'string' || !ID.test(id)) return { ok: false };
    const owned = await this.prisma.liveStream.findFirst({ where: { id, status: { in: ['IDLE', 'LIVE'] }, channel: { userId: user.id } }, select: { id: true } });
    if (!socket.connected || !owned) return { ok: false };
    const premium = user.premiumUntil && user.premiumUntil > new Date();
    const room = this.guests.open(socket, premium && basic === false ? 6 : 2);
    return room ? { ok: true, ...room } : { ok: false };
  }

  @SubscribeMessage('live:guest-join')
  async joinGuest(@ConnectedSocket() socket: Socket, @MessageBody() token: unknown) {
    const userId = socket.data.userId as string | undefined;
    if (!userId || socket.data.guestJoining || socket.data.guestHost || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return { ok: false };
    socket.data.guestJoining = true;
    try {
      if (this.guests.hasInvite(token)) return this.guests.join(socket, token);
      await this.limits.consume(`live:guest:${userId}`, 15, 60, 'Too many guest joins.');
      const results = await socket.nsp.serverSideEmitWithAck('freeme:guest-join', socket.id, userId, token);
      const result = results.find(Boolean) as { ok: boolean; host?: string; error?: string } | undefined;
      if (result?.ok) {
        if (!socket.connected) {
          socket.nsp.serverSideEmit('freeme:guest-leave', socket.id);
          return { ok: false };
        }
        socket.data.guestHost = result.host;
      }
      return result ?? { ok: false, error: 'This guest invitation is unavailable.' };
    } catch {
      return { ok: false, error: 'Could not reach the green room. Try again shortly.' };
    } finally { socket.data.guestJoining = false; }
  }

  @SubscribeMessage('live:guest-signal')
  signalGuest(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const { target, payload } = (body ?? {}) as { target?: unknown; payload?: unknown };
    if (typeof target !== 'string' || !payload || typeof payload !== 'object') return { ok: false };
    if (JSON.stringify(payload).length > 24_000) return { ok: false };
    if (this.guests.signal(socket, target, payload)) return { ok: true };
    if (socket.data.guestHost !== target) return { ok: false };
    socket.nsp.serverSideEmit('freeme:guest-relay', socket.id, target, payload);
    return { ok: true };
  }

  @SubscribeMessage('live:guest-remove')
  removeGuest(@ConnectedSocket() socket: Socket, @MessageBody() target: unknown) {
    return { ok: typeof target === 'string' && this.guests.remove(socket, target) };
  }

  @SubscribeMessage('live:guest-leave')
  leaveGuests(@ConnectedSocket() socket: Socket) {
    this.guests.leave(socket);
    if (socket.data.guestHost) {
      socket.nsp.serverSideEmit('freeme:guest-leave', socket.id);
      delete socket.data.guestHost;
    }
  }

  @SubscribeMessage('live:chat')
  async chat(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const { streamId, text } = (body ?? {}) as { streamId?: unknown; text?: unknown };
    const u = await this.user(socket);
    if (!u || u.status !== 'ACTIVE') return { ok: false, error: 'Sign in to chat.' };
    if (typeof streamId !== 'string' || !ID.test(streamId) || typeof text !== 'string') return { ok: false };
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    if (!clean) return { ok: false };
    try { await this.limits.consume(`live:chat:${u.id}`, 10, 20, 'You are sending messages very fast.'); } catch { return { ok: false, error: 'You are sending messages very fast.' }; }
    const s = await this.prisma.liveStream.findUnique({ where: { id: streamId }, select: { status: true, channelId: true, chatMode: true, slowModeSeconds: true } });
    if (s?.status !== 'LIVE') return { ok: false, error: 'This stream is not live.' };
    const who = await this.prisma.user.findUniqueOrThrow({ where: { id: u.id }, include: { profile: true, channel: true } });
    const host = who.channel?.id === s.channelId;
    // The host's chat rules (the host can always write).
    if (!host) {
      if (s.chatMode === 'off') return { ok: false, error: 'Chat is turned off for this stream.' };
      if (s.chatMode === 'followers' && !(await this.prisma.subscription.findUnique({ where: { userId_channelId: { userId: u.id, channelId: s.channelId } }, select: { id: true } }))) {
        return { ok: false, error: 'Only followers can chat. Tune in to join the conversation.' };
      }
      if (s.slowModeSeconds > 0) {
        try { await this.limits.consume(`live:slow:${streamId}:${u.id}`, 1, s.slowModeSeconds, 'Slow mode'); }
        catch { return { ok: false, error: `Slow mode: one message every ${s.slowModeSeconds} seconds.` }; }
      }
    }
    await this.live.say(streamId, {
      id: `${Date.now()}-${socket.id.slice(0, 6)}`, text: clean, at: new Date().toISOString(),
      author: { name: who.channel?.name ?? who.profile?.displayName ?? 'Viewer', handle: who.channel?.handle ?? null, avatarUrl: who.channel?.avatarUrl ?? who.profile?.avatarUrl ?? null, verified: !!who.channel?.isVerified, host: who.channel?.id === s.channelId },
    });
    return { ok: true };
  }

  /**
   * Live captions: the host's browser turns their speech into text (Web Speech API) and sends it here; viewers get it
   * as a caption line. Only the host of a live stream that allows captions can send; lines are short and rate limited.
   */
  @SubscribeMessage('live:caption')
  async caption(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const { streamId, text, final } = (body ?? {}) as { streamId?: unknown; text?: unknown; final?: unknown };
    const userId = socket.data.userId as string | undefined;
    if (!userId || typeof streamId !== 'string' || !ID.test(streamId) || typeof text !== 'string') return { ok: false };
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(-240);
    if (!clean) return { ok: false };
    try { await this.limits.consume(`live:caption:${userId}`, 40, 10); } catch { return { ok: false }; }
    const s = await this.prisma.liveStream.findFirst({ where: { id: streamId, status: 'LIVE', captionsEnabled: true, channel: { userId } }, select: { id: true } });
    if (!s) return { ok: false };
    publish(room.live(streamId), 'caption', { text: clean, final: final === true, at: Date.now() });
    return { ok: true };
  }

  /** The host asks a question: `{ streamId, question, options }` (2 to 4 answers). */
  @SubscribeMessage('live:poll-start')
  async pollStart(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const { streamId, question, options } = (body ?? {}) as { streamId?: unknown; question?: unknown; options?: unknown };
    const userId = socket.data.userId as string | undefined;
    if (!userId || typeof streamId !== 'string' || !ID.test(streamId) || typeof question !== 'string' || !Array.isArray(options)) return { ok: false };
    const q = clean(question, 120);
    const answers = options.filter((o): o is string => typeof o === 'string').map((o) => clean(o, 60)).filter(Boolean);
    if (!q || answers.length < 2 || answers.length > 4 || new Set(answers.map((a) => a.toLowerCase())).size !== answers.length) return { ok: false, error: 'Ask a question with 2 to 4 different answers.' };
    try { await this.limits.consume(`live:poll:${userId}`, 10, 600); } catch { return { ok: false, error: 'Too many polls. Wait a few minutes.' }; }
    if (!(await this.hosts(userId, streamId))) return { ok: false, error: 'Only the host can start a poll while live.' };
    return { ok: true, poll: await this.live.startPoll(streamId, q, answers) };
  }

  @SubscribeMessage('live:poll-close')
  async pollClose(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const { streamId } = (body ?? {}) as { streamId?: unknown };
    const userId = socket.data.userId as string | undefined;
    if (!userId || typeof streamId !== 'string' || !ID.test(streamId) || !(await this.hosts(userId, streamId))) return { ok: false };
    return { ok: true, poll: await this.live.closePoll(streamId) };
  }

  /** A signed-in viewer votes: `{ streamId, pollId, option }`; one vote per account per poll. */
  @SubscribeMessage('live:poll-vote')
  async pollVote(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const { streamId, pollId, option } = (body ?? {}) as { streamId?: unknown; pollId?: unknown; option?: unknown };
    const u = await this.user(socket);
    if (!u || u.status !== 'ACTIVE') return { ok: false, error: 'Sign in to vote.' };
    if (typeof streamId !== 'string' || !ID.test(streamId) || typeof pollId !== 'string' || !ID.test(pollId) || typeof option !== 'number') return { ok: false };
    try { await this.limits.consume(`live:vote:${u.id}`, 20, 60); } catch { return { ok: false, error: 'Slow down a little.' }; }
    const r = await this.live.vote(streamId, pollId, u.id, option);
    if (!r) return { ok: false, error: 'Voting has closed.' };
    return { ok: true, counted: r.counted, poll: r.poll };
  }

  /** The signed-in owner of a stream that is live now. */
  private async hosts(userId: string, streamId: string) {
    return !!(await this.prisma.liveStream.findFirst({ where: { id: streamId, status: 'LIVE', channel: { userId } }, select: { id: true } }));
  }

  handleDisconnect(socket: Socket) { this.leaveGuests(socket); this.live.dropSocket(socket.id); }
}
