import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../database/prisma.service';
import { clientIp, userAgent } from './request';

/** Permanent record of security and administrative actions: who, what, on which record, from where. */
@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');
  constructor(private readonly prisma: PrismaService) {}

  async record(e: { userId: string | null; action: string; entityType: string; entityId?: string | null; req?: Request; details?: Record<string, unknown> }) {
    try {
      await this.prisma.auditLog.create({ data: {
        userId: e.userId, action: e.action, entityType: e.entityType, entityId: e.entityId ?? null,
        ipAddress: e.req ? clientIp(e.req) : null, userAgent: e.req ? userAgent(e.req) : null,
        detailsJson: e.details ? JSON.stringify(e.details).slice(0, 8000) : null,
      } });
    } catch (err) {
      // An audit failure is logged loudly; the action itself has already been validated and done.
      this.log.error(`Could not write audit entry ${e.action}: ${(err as Error).message}`);
    }
  }
}
