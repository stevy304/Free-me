import { ConnectedSocket, MessageBody, type OnGatewayDisconnect, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { PrismaService } from '../database/prisma.service';
import { RateLimitService } from '../common/rate-limit.service';
import { LiveError, LiveService } from './live.service';

const ID = /^[0-9a-f-]{36}$/;

/**
 * Live over the socket: a creator's browser sends its recording in one-second pieces; viewers chat.
 * (Same endpoint as RealtimeGateway, which signs the socket in and puts it in its rooms.)
 */
@WebSocketGateway({ path: '/api/socket', addTrailingSlash: false, serveClient: false, transports: ['websocket'], maxHttpBufferSize: 8 * 1024 * 1024 })
export class LiveGateway implements OnGatewayDisconnect {
  constructor(private readonly live: LiveService, private readonly prisma: PrismaService, private readonly limits: RateLimitService) {}

  private async user(socket: Socket) {
    const id = socket.data.userId as string | undefined;
    return id ? this.prisma.user.findUnique({ where: { id } }) : null;
  }

  @SubscribeMessage('live:start')
  async start(@ConnectedSocket() socket: Socket, @MessageBody() streamId: unknown) {
    const u = await this.user(socket);
    if (!u || u.status !== 'ACTIVE') return { ok: false, error: 'Sign in to go live.' };
    if (typeof streamId !== 'string' || !ID.test(streamId)) return { ok: false, error: 'Stream not found.' };
    try { const s = await this.live.startBrowser(u, streamId, socket.id); return { ok: true, id: s.id }; }
    catch (e) { return { ok: false, error: e instanceof LiveError ? e.message : 'The stream could not start.' }; }
  }

  @SubscribeMessage('live:chunk')
  chunk(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const [streamId, data] = Array.isArray(body) ? body : [];
    if (typeof streamId !== 'string' || !Buffer.isBuffer(data)) return { ok: false };
    return { ok: this.live.chunk(streamId, socket.id, data) };
  }

  @SubscribeMessage('live:stop')
  async stop(@ConnectedSocket() socket: Socket, @MessageBody() streamId: unknown) {
    if (typeof streamId !== 'string') return { ok: false };
    return { ok: await this.live.stopBrowser(streamId, socket.id) };
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

  async handleDisconnect(socket: Socket) { await this.live.dropSocket(socket.id); }
}
