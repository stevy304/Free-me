import { Module } from '@nestjs/common';
import { HubNoticesController, ModerationController } from './moderation.controller';
import { ReportsController } from './reports.controller';

@Module({ controllers: [ReportsController, ModerationController, HubNoticesController] })
export class TrustModule {}
