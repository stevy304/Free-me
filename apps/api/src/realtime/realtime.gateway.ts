import { Inject, Logger, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { ConnectedSocket, MessageBody, type OnGatewayConnection, type OnGatewayInit, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server, Socket } from 'socket.io';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { SessionService } from '../auth/session.service';
import { JOINABLE, room, setRealtimeSink } from './publish';

const cookieValue = (header: string | undefined, name: string) => {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; } }
  }
  return undefined;
};

/**
 * The socket.io endpoint (/api/socket, WebSocket only, so any API server can take any browser without sticky
 * sessions). Signed-in browsers join their own room; watch and live pages join the video's room.
 */
@WebSocketGateway({ path: '/api/socket', addTrailingSlash: false, serveClient: false, transports: ['websocket'], maxHttpBufferSize: 8 * 1024 * 1024 })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy, OnApplicationShutdown {
  private readonly log = new Logger('Realtime');
  private redis: Redis[] = [];
  private readonly origins: Set<string>;
  private server: Server | null = null;
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig, private readonly sessions: SessionService) {
    this.origins = new Set([config.appUrl, ...config.extraOrigins]);
  }

  afterInit(server: Server) {
    this.server = server;
    if (this.config.redisUrl) {
      const pub = new Redis(this.config.redisUrl, { maxRetriesPerRequest: null }); const sub = pub.duplicate();
      pub.on('error', () => undefined); sub.on('error', () => undefined);
      this.redis = [pub, sub];
      server.adapter(createAdapter(pub, sub));
    }
    setRealtimeSink((r, event, data) => server.to(r).emit(event, data));
  }

  async handleConnection(socket: Socket) {
    // Only the web app's own pages may connect (a cross-site page cannot ride a viewer's session).
    const origin = socket.handshake.headers.origin;
    if (origin && !this.origins.has(origin)) { socket.disconnect(true); return; }
    try {
      const auth = await this.sessions.resolve(cookieValue(socket.handshake.headers.cookie, this.sessions.cookieName));
      if (auth && auth.user.status === 'ACTIVE') { socket.data.userId = auth.user.id; await socket.join(room.user(auth.user.id)); }
    } catch (e) { this.log.warn(`connection: ${(e as Error).message}`); }
  }

  @SubscribeMessage('join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() r: unknown) {
    if (typeof r !== 'string' || !JOINABLE.test(r) || socket.rooms.size > 20) return { ok: false };
    await socket.join(r);
    return { ok: true };
  }

  @SubscribeMessage('leave')
  async leave(@ConnectedSocket() socket: Socket, @MessageBody() r: unknown) {
    if (typeof r === 'string' && JOINABLE.test(r)) await socket.leave(r);
    return { ok: true };
  }

  /** People in a room (all servers), e.g. live viewers. */
  async count(r: string) { return this.server ? (await this.server.in(r).fetchSockets()).length : 0; }

  get io() { return this.server; }

  onModuleDestroy() { setRealtimeSink(null); }

  /** After the socket server has closed (it unsubscribes through these connections first). */
  async onApplicationShutdown() {
    await Promise.allSettled(this.redis.map((r) => (r.status === 'end' ? Promise.resolve() : r.quit())));
  }
}
