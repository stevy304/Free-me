import { Module } from '@nestjs/common';
import { BillingController, BillingService } from './billing.controller';
import { AdsController } from './ads.controller';
import { AdminBillingController, MonetisationController } from './monetisation.controller';
import { AdminPaymentSettingsController } from './admin-settings.controller';

@Module({ controllers: [BillingController, AdsController, MonetisationController, AdminBillingController, AdminPaymentSettingsController], providers: [BillingService], exports: [BillingService] })
export class BillingModule {}
