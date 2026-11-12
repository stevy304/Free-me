import { SupportController } from './support.controller';
import { PayoutsController } from './payouts.controller';
import { PayoutSandboxController } from './payout-sandbox.controller';
import { Module } from '@nestjs/common';
import { BillingController, BillingService } from './billing.controller';
import { AdsController } from './ads.controller';
import { AdminBillingController, MonetisationController } from './monetisation.controller';
import { AdminPaymentSettingsController } from './admin-settings.controller';

@Module({ controllers: [SupportController, PayoutsController, PayoutSandboxController, BillingController, AdsController, MonetisationController, AdminBillingController, AdminPaymentSettingsController], providers: [BillingService], exports: [BillingService] })
export class BillingModule {}
