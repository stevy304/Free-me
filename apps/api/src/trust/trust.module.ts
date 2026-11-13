import { Module } from '@nestjs/common';
import { HubNoticesController, ModerationController } from './moderation.controller';
import { ReportsController } from './reports.controller';
import { SafetyController } from './safety.controller';

@Module({ controllers: [ReportsController, ModerationController, HubNoticesController, SafetyController] })
export class TrustModule {}
