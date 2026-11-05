import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import type { RequestWithId } from './request-log';

/** Known errors keep their message; anything unexpected is logged with its stack and answered with a generic 500. */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof HttpException) { res.status(err.getStatus()).json(typeof err.getResponse() === 'string' ? { statusCode: err.getStatus(), message: err.getResponse() } : err.getResponse()); return; }
    // Errors from the body parsers (too large, malformed) carry their own status and safe message.
    const e = err as { status?: number; expose?: boolean; message?: string };
    if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500 && e.expose) { res.status(e.status).json({ statusCode: e.status, message: e.status === 413 ? 'The request is too large.' : e.message }); return; }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') { res.status(409).json({ statusCode: 409, message: 'This already exists.' }); return; }
    // The request id ties the user's report to this log line.
    const requestId = host.switchToHttp().getRequest<RequestWithId>().id;
    this.log.error(`[${requestId ?? '-'}] ${(err as Error)?.stack ?? String(err)}`);
    res.status(500).json({ statusCode: 500, message: 'Something went wrong on our side. Please try again.', requestId });
  }
}
