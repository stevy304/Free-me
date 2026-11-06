import { Module } from '@nestjs/common';
import { BillingController, BillingService } from './billing.controller';
import { AdsController } from './ads.controller';
import { AdminBillingController, MonetisationController } from './monetisation.controller';

@Module({ controllers: [BillingController, AdsController, MonetisationController, AdminBillingController], providers: [BillingService], exports: [BillingService] })
export class BillingModule {}
