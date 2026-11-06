import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { PushController } from '../push/push.controller';

@Module({ controllers: [NotificationsController, PushController] })
export class NotificationsModule {}
