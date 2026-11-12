import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { BillingService, paymentView } from './billing.controller';
import { createMomoSandboxUser, ProviderError, testFlutterwave, testMomo } from './providers';
import { effective, loadStored, mask, saveStored, type ManualAccount, type StoredBilling } from './settings';

const SANDBOX = 'https://sandbox.momodeveloper.mtn.com';
class SandboxDto { @ApiProperty({ description: 'Primary key of your Collections subscription (momodeveloper.mtn.com → Profile)' }) @IsString() @MaxLength(100) subscriptionKey!: string }
class ConfirmDto { @ApiProperty() @IsBoolean() approve!: boolean; @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string }

type Payload = Record<string, unknown>;
const obj = (v: unknown): Payload | null | undefined => (v === null ? null : v && typeof v === 'object' && !Array.isArray(v) ? v as Payload : undefined);
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const cents = (v: unknown, what: string) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10_000_000) throw new BadRequestException(`${what}: enter an amount in US cents (e.g. 1000 for $10).`);
  return n;
};
const rate = (v: unknown, currency: string) => {
  if (currency === 'USD') return 1;
  const n = Number(v);
  if (!(n > 0) || n > 1_000_000) throw new BadRequestException(`Enter how many ${currency} make one US dollar (e.g. 1450).`);
  return n;
};
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Administration → Money → Payment settings: prices, MTN MoMo, Flutterwave and manual payments, set in the app
 * (no server files to edit). Secrets are stored encrypted and never shown again in full.
 */
@ApiTags('admin')
@Controller('admin/billing')
@RequireAuth('ADMIN')
export class AdminPaymentSettingsController {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService, private readonly audit: AuditService) {}

  private async view() {
    const stored = await loadStored(this.prisma, this.billing.cfg);
    const eff = effective(this.billing.cfg, stored);
    const env = this.billing.cfg.billing;
    const source = (k: 'momo' | 'flutterwave') => (stored[k] !== undefined ? 'app' : env[k] ? 'environment' : 'none');
    const m = stored.momo ?? null;
    return {
      prices: { premiumUsdCents: eff.premiumUsdCents, adDayUsdCents: eff.adDayUsdCents, adCpmUsdCents: eff.adCpmUsdCents, payoutMinUsdCents: eff.payoutMinUsdCents },
      momo: {
        source: source('momo'), active: !!eff.momo,
        enabled: m ? m.enabled : !!env.momo, sandbox: (m?.baseUrl ?? env.momo?.baseUrl ?? SANDBOX).includes('sandbox'),
        baseUrl: m?.baseUrl ?? env.momo?.baseUrl ?? SANDBOX, targetEnvironment: m?.targetEnvironment ?? env.momo?.targetEnvironment ?? 'sandbox',
        apiUser: m?.apiUser ?? env.momo?.apiUser ?? '', subscriptionKey: mask(m?.subscriptionKey ?? env.momo?.subscriptionKey), apiKey: mask(m?.apiKey ?? env.momo?.apiKey),
        currency: m?.currency ?? env.momo?.currency ?? 'RWF', perUsd: m?.perUsd ?? env.momo?.perUsd ?? null,
      },
      flutterwave: {
        source: source('flutterwave'), active: !!eff.flutterwave, enabled: stored.flutterwave ? stored.flutterwave.enabled : !!env.flutterwave,
        secretKey: mask(stored.flutterwave?.secretKey ?? env.flutterwave?.secretKey), webhookHash: mask(stored.flutterwave?.webhookHash ?? env.flutterwave?.webhookHash),
        webhookUrl: `${this.billing.cfg.appUrl}/api/billing/webhooks/flutterwave`,
      },
      manual: { active: !!eff.manual, enabled: !!stored.manual?.enabled, currency: stored.manual?.currency ?? 'RWF', perUsd: stored.manual?.perUsd ?? null, accounts: stored.manual?.accounts ?? [], instructions: stored.manual?.instructions ?? null },
    };
  }

  @Get('settings')
  @ApiOperation({ summary: 'Payment settings (secrets masked)' })
  settings() { return this.view(); }

  @Put('settings')
  @ApiOperation({ summary: 'Save payment settings. Leave a secret empty to keep the saved one; send a group as null to remove it (the environment applies again).' })
  async save(@CurrentAuth() auth: AuthContext, @Body() body: Payload, @Req() req: AppRequest) {
    const cur = await loadStored(this.prisma, this.billing.cfg);
    const next: StoredBilling = { ...cur };
    const prices = obj(body.prices);
    if (prices) {
      next.premiumUsdCents = cents(prices.premiumUsdCents, 'Premium price') ?? next.premiumUsdCents;
      next.adDayUsdCents = cents(prices.adDayUsdCents, 'Ad price per day') ?? next.adDayUsdCents;
      next.adCpmUsdCents = cents(prices.adCpmUsdCents, 'Price per 1,000 ad views') ?? next.adCpmUsdCents;
      next.payoutMinUsdCents = cents(prices.payoutMinUsdCents, 'Smallest withdrawal') ?? next.payoutMinUsdCents;
    }
    const m = obj(body.momo);
    if (m === null) delete next.momo;
    else if (m) {
      const env = this.billing.cfg.billing.momo;
      const sandbox = m.sandbox !== false;
      const currency = (str(m.currency, 3) || (sandbox ? 'EUR' : 'RWF')).toUpperCase();
      if (!CURRENCY.test(currency)) throw new BadRequestException('MoMo currency: a 3-letter code such as RWF.');
      const merged = {
        enabled: m.enabled !== false,
        baseUrl: sandbox ? SANDBOX : (str(m.baseUrl, 200) || cur.momo?.baseUrl || env?.baseUrl || ''),
        targetEnvironment: sandbox ? 'sandbox' : (str(m.targetEnvironment, 40) || cur.momo?.targetEnvironment || 'mtnrwanda'),
        subscriptionKey: str(m.subscriptionKey, 100) || cur.momo?.subscriptionKey || env?.subscriptionKey || '',
        apiUser: str(m.apiUser, 100) || cur.momo?.apiUser || env?.apiUser || '',
        apiKey: str(m.apiKey, 100) || cur.momo?.apiKey || env?.apiKey || '',
        currency, perUsd: rate(m.perUsd ?? cur.momo?.perUsd, currency),
      };
      if (!sandbox && !/^(https:\/\/[^/]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)/.test(merged.baseUrl)) throw new BadRequestException('Live MoMo: enter the address MTN gave you (https://…).');
      if (merged.enabled && (!merged.subscriptionKey || !merged.apiUser || !merged.apiKey)) throw new BadRequestException('MoMo needs the subscription key, API user and API key (or use "Create sandbox keys").');
      next.momo = merged;
    }
    const f = obj(body.flutterwave);
    if (f === null) delete next.flutterwave;
    else if (f) {
      const secretKey = str(f.secretKey, 200) || cur.flutterwave?.secretKey || '';
      if (f.enabled !== false && !secretKey) throw new BadRequestException('Flutterwave needs its secret key.');
      next.flutterwave = { enabled: f.enabled !== false, secretKey, webhookHash: str(f.webhookHash, 200) || cur.flutterwave?.webhookHash || null };
    }
    const man = obj(body.manual);
    if (man === null) delete next.manual;
    else if (man) {
      const currency = (str(man.currency, 3) || 'RWF').toUpperCase();
      if (!CURRENCY.test(currency)) throw new BadRequestException('Manual payments currency: a 3-letter code such as RWF.');
      const accounts: ManualAccount[] = (Array.isArray(man.accounts) ? man.accounts : []).slice(0, 6).map((a) => {
        const o = obj(a) ?? {};
        return { label: str(o.label, 40) ?? '', number: str(o.number, 60) ?? '', name: str(o.name, 80) ?? '' };
      }).filter((a) => a.label || a.number || a.name);
      if (accounts.some((a) => !a.label || !a.number || !a.name)) throw new BadRequestException('Each account needs a name for the method (e.g. MTN MoMo), the number or account and the account holder\'s name.');
      if (man.enabled !== false && !accounts.length) throw new BadRequestException('Add at least one account people can pay to.');
      next.manual = { enabled: man.enabled !== false, currency, perUsd: rate(man.perUsd ?? cur.manual?.perUsd, currency), accounts, instructions: str(man.instructions, 500) || null };
    }
    await saveStored(this.prisma, this.billing.cfg, next, auth.user.id);
    this.billing.invalidate();
    await this.audit.record({ userId: auth.user.id, action: 'PAYMENT_SETTINGS_CHANGED', entityType: 'AppSetting', entityId: 'billing', req, details: { groups: Object.keys(body) } });
    return this.view();
  }

  @Post('settings/momo/sandbox')
  @HttpCode(200)
  @ApiOperation({ summary: 'MTN MoMo sandbox: create the API user and key from your subscription key, save and switch MoMo on (test money only)' })
  async sandbox(@CurrentAuth() auth: AuthContext, @Body() body: SandboxDto, @Req() req: AppRequest) {
    const host = new URL(this.billing.cfg.appUrl).hostname;
    try {
      const { apiUser, apiKey } = await createMomoSandboxUser(SANDBOX, body.subscriptionKey.trim(), host);
      const cur = await loadStored(this.prisma, this.billing.cfg);
      await saveStored(this.prisma, this.billing.cfg, { ...cur, momo: { enabled: true, baseUrl: SANDBOX, targetEnvironment: 'sandbox', subscriptionKey: body.subscriptionKey.trim(), apiUser, apiKey, currency: 'EUR', perUsd: cur.momo?.currency === 'EUR' ? cur.momo.perUsd : 0.92 } }, auth.user.id);
      this.billing.invalidate();
      await this.audit.record({ userId: auth.user.id, action: 'PAYMENT_SETTINGS_CHANGED', entityType: 'AppSetting', entityId: 'billing', req, details: { momoSandbox: true } });
      return this.view();
    } catch (e) { throw new BadRequestException(e instanceof ProviderError ? e.message : 'MTN could not be reached. Try again in a moment.'); }
  }

  @Post('settings/test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check the saved MoMo and Flutterwave keys with the providers' })
  async test() {
    const eff = await this.billing.settings();
    const check = async (on: boolean, fn: () => Promise<void>) => { if (!on) return { ok: false, message: 'Not set up.' }; try { await fn(); return { ok: true, message: 'Connected.' }; } catch (e) { return { ok: false, message: e instanceof ProviderError ? e.message : 'Could not be reached.' }; } };
    return { momo: await check(!!eff.momo, () => testMomo(eff.momo!)), flutterwave: await check(!!eff.flutterwave, () => testFlutterwave(eff.flutterwave!)) };
  }

  @Get('manual')
  @ApiOperation({ summary: 'Manual payments waiting for confirmation (newest first)' })
  async manual() {
    const rows = await this.prisma.payment.findMany({ where: { provider: 'manual', status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 100, include: { user: { select: { email: true } } } });
    return { payments: rows.map((p) => ({ ...paymentView(p), email: p.user.email })) };
  }

  @Post('payments/:id/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm a manual payment arrived (Premium or the ad starts) or reject it' })
  async confirm(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ConfirmDto, @Req() req: AppRequest) {
    if (!body.approve && !body.reason?.trim()) throw new BadRequestException('Say why; the payer will see it.');
    const p = await this.billing.attempt(() => this.billing.confirmManual(id, body.approve, body.reason));
    await this.audit.record({ userId: auth.user.id, action: body.approve ? 'MANUAL_PAYMENT_CONFIRMED' : 'MANUAL_PAYMENT_REJECTED', entityType: 'Payment', entityId: id, req, details: { reason: body.reason ?? null } });
    return { payment: paymentView(p) };
  }
}
