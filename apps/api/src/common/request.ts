import type { Request } from 'express';
import type { Session, User } from '@prisma/client';

/** What the session middleware attaches to each request. */
export interface AuthContext { user: User; session: Session }
export type AppRequest = Request & { auth?: AuthContext | null };

export const clientIp = (req: Request): string | null => (req.ip || req.socket?.remoteAddress || null)?.replace(/^::ffff:/, '') ?? null;
export const userAgent = (req: Request): string | null => (req.headers['user-agent'] ?? '').slice(0, 400) || null;
