import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { RateLimitService } from './rate-limit.service';

@Global()
@Module({ providers: [AuditService, RateLimitService], exports: [AuditService, RateLimitService] })
export class CommonModule {}
