import { BadRequestException, Body, Controller, Get, Inject, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsObject } from 'class-validator';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import { AuditService } from '../common/audit.service';
import type { AppRequest, AuthContext } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { SECRETS, SECRET_NAMES, saveSecrets, secretStatus, type SecretName } from '../settings/secrets';

class SecretsDto { @IsObject() values!: Record<string, string> }

/** Administration → Secrets: keys for outside services, write-only (settings/secrets.ts). */
@ApiTags('admin')
@Controller('admin/secrets')
@RequireAuth('ADMIN')
export class SecretsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  @ApiOperation({ summary: 'Which keys are set and where from (never their values)' })
  async list() { return { secrets: await secretStatus(this.prisma, this.config) }; }

  @Put()
  @ApiOperation({ summary: 'Save keys (only the ones given; an empty value removes a saved one). The values are never returned.' })
  async save(@Body() body: SecretsDto, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const values: Partial<Record<SecretName, string>> = {};
    for (const [name, value] of Object.entries(body.values)) {
      if (!(SECRET_NAMES as string[]).includes(name)) throw new BadRequestException(`Unknown key: ${name}.`);
      if (typeof value !== 'string' || value.length > 500) throw new BadRequestException(`${SECRETS[name as SecretName].label}: not a valid value.`);
      const v = value.trim();
      if (v && !SECRETS[name as SecretName].pattern.test(v)) throw new BadRequestException(`${SECRETS[name as SecretName].label}: that does not look right (${SECRETS[name as SecretName].hint}).`);
      values[name as SecretName] = v;
    }
    const changed = await saveSecrets(this.prisma, this.config, values, auth.user.id);
    // Which keys changed, never their values.
    if (changed.length) await this.audit.record({ userId: auth.user.id, action: 'SECRETS_SAVED', entityType: 'AppSetting', entityId: 'secrets', req, details: { keys: changed } });
    return { saved: changed, secrets: await secretStatus(this.prisma, this.config) };
  }
}
