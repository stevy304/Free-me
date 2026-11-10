import { ConnectedSocket, MessageBody, type OnGatewayDisconnect, type OnGatewayInit, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { PrismaService } from '../database/prisma.service';
import { RateLimitService } from '../common/rate-limit.service';
import { LiveGuests } from './live-guests';
import { LiveError, LiveService } from './live.service';

const ID = /^[0-9a-f-]{36}$/;

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
    const s = await this.prisma.liveStream.findUnique({ where: { id: streamId }, select: { status: true, channelId: true } });
    if (s?.status !== 'LIVE') return { ok: false, error: 'This stream is not live.' };
    const who = await this.prisma.user.findUniqueOrThrow({ where: { id: u.id }, include: { profile: true, channel: true } });
    await this.live.say(streamId, {
      id: `${Date.now()}-${socket.id.slice(0, 6)}`, text: clean, at: new Date().toISOString(),
      author: { name: who.channel?.name ?? who.profile?.displayName ?? 'Viewer', handle: who.channel?.handle ?? null, avatarUrl: who.channel?.avatarUrl ?? who.profile?.avatarUrl ?? null, verified: !!who.channel?.isVerified, host: who.channel?.id === s.channelId },
    });
    return { ok: true };
  }

  handleDisconnect(socket: Socket) { this.leaveGuests(socket); this.live.dropSocket(socket.id); }
}
