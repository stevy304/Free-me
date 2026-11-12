import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from './config/config';
import { DatabaseModule } from './database/database.module';
import { CommonModule } from './common/common.module';
import { MailModule } from './mail/mail.module';
import { OriginGuard } from './common/origin.guard';
import { AuthGuard } from './common/auth.guard';
import { ErrorsFilter } from './common/errors.filter';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ChannelsModule } from './channels/channels.module';
import { CatalogModule } from './catalog/catalog.module';
import { AdminModule } from './admin/admin.module';
import { VideosModule } from './videos/videos.module';
import { HealthController } from './health/health.controller';
import { SiteController } from './health/site.controller';
import { EngagementModule } from './engagement/engagement.module';
import { NotificationsModule } from './notifications/notifications.module';
import { TrustModule } from './trust/trust.module';
import { BillingModule } from './billing/billing.module';
import { RealtimeModule } from './realtime/realtime.module';
import { LiveModule } from './live/live.module';
import { MetricsController } from './metrics/metrics.controller';
import { METRICS, createRegistry } from './metrics/metrics';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DatabaseModule, CommonModule, MailModule, VideosModule, AuthModule, UsersModule, ChannelsModule, CatalogModule, AdminModule, EngagementModule, TrustModule, NotificationsModule, BillingModule, RealtimeModule, LiveModule],
      controllers: [HealthController, SiteController, MetricsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        // One registry per application instance (the tests start several in one process).
        { provide: METRICS, useFactory: () => createRegistry('api') },
        { provide: APP_GUARD, useClass: OriginGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorsFilter },
      ],
      exports: [APP_CONFIG, METRICS],
    };
  }
}
