import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { AppRequest } from '../common/request';
import { SessionService } from './session.service';

/** Reads the session cookie on every request and attaches the account (or null) as req.auth. */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(private readonly sessions: SessionService) {}
  async use(req: AppRequest, _res: Response, next: NextFunction) {
    try { req.auth = await this.sessions.resolve(req.cookies?.[this.sessions.cookieName]); next(); } catch (e) { next(e); }
  }
}
