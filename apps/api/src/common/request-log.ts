import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { clientIp, type AppRequest } from './request';

export type RequestWithId = AppRequest & { id?: string };

/** An id the edge (Caddy) or a client sent, if it looks like one; otherwise a new one. */
const fromHeader = (v: unknown) => (typeof v === 'string' && /^[\w.-]{8,80}$/.test(v) ? v : null);

/**
 * Gives every request an id (returned as X-Request-Id, and shown in "something went wrong" answers so a user can
 * quote it) and, when `json` is on, writes one JSON line per request for log collectors. Health checks are skipped.
 */
export function requestLog(opts: { json: boolean; write?: (line: string) => void }) {
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
  return (req: Request, res: Response, next: NextFunction) => {
    const r = req as RequestWithId;
    r.id = fromHeader(req.headers['x-request-id']) ?? randomUUID();
    res.setHeader('X-Request-Id', r.id);
    if (!opts.json) { next(); return; }
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const path = (req.originalUrl || req.url).split('?')[0];
      if (path === '/api/health') return;
      write(JSON.stringify({
        time: new Date().toISOString(), level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', msg: 'request',
        requestId: r.id, method: req.method, path, status: res.statusCode, ms: Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10,
        ip: clientIp(req), userId: r.auth?.user.id ?? null, bytes: Number(res.getHeader('content-length')) || undefined,
      }));
    });
    next();
  };
}
