import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import { IsIn, IsInt, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { RequireAuth, CurrentAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { AuditService } from '../common/audit.service';
import { BillingService } from './billing.controller';
import { msisdn } from './billing';
import { FlutterwavePayoutSandbox } from './payout-sandbox';

class SandboxDto {
  @IsString() @Length(6, 24) phone!: string;
  @IsString() @Length(2, 100) accountHolderName!: string;
  @IsInt() @Min(100) @Max(100_000) amountRwf!: number;
  @IsUUID() requestId!: string;
  @IsIn(['success', 'failure', 'pending']) scenario!: 'success' | 'failure' | 'pending';
}

@Controller('admin/billing/payout-sandbox')
@RequireAuth('ADMIN')
export class PayoutSandboxController {
  constructor(private readonly billing: BillingService, private readonly audit: AuditService) {}

  @Get()
  config() { return { enabled: !!this.billing.cfg.billing.payoutSandbox, mode: 'TEST_ONLY', currency: 'RWF', network: 'MTN', changesBalances: false }; }

  private transfer(body: SandboxDto) {
    const phone = msisdn(body.phone, 'RWF');
    if (!phone || !/^2507\d{8}$/.test(phone) || body.accountHolderName.trim().length < 2) throw new BadRequestException('Enter the test wallet number and name.');
    const suffix = body.scenario === 'success' ? '_PMCKDU_1' : body.scenario === 'failure' ? '_PMCK_ST_FDU_1' : '';
    return { phone, accountHolderName: body.accountHolderName.trim(), amountRwf: body.amountRwf, reference: `FMTEST_${body.requestId}${suffix}` };
  }

  private provider() {
    const config = this.billing.cfg.billing.payoutSandbox;
    if (!config) throw new BadRequestException('Set FLW_PAYOUT_TEST_KEY to enable sandbox transfers.');
    return new FlutterwavePayoutSandbox(config.secretKey);
  }

  @Post()
  async start(@Body() body: SandboxDto, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const result = await this.provider().start(this.transfer(body));
    await this.audit.record({ userId: auth.user.id, action: 'PAYOUT_SANDBOX_STARTED', entityType: 'SandboxTransfer', entityId: String(result.id), req });
    return result;
  }

  @Post(':id/check')
  @HttpCode(200)
  async check(@Param('id', ParseIntPipe) id: number, @Body() body: SandboxDto) {
    if (id < 1) throw new BadRequestException('Invalid test transfer.');
    return this.provider().check(id, this.transfer(body));
  }
}
