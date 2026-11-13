import { PlaybackHealthController } from './playback-health.controller';
import { QoeController } from './qoe.controller';
import { Module } from '@nestjs/common';
import { CollectionsController } from './collections.controller';
import { CommentsController } from './comments.controller';
import { MessagesController } from './messages.controller';
import { ReactionsController } from './reactions.controller';

@Module({ controllers: [PlaybackHealthController, QoeController, ReactionsController, CommentsController, CollectionsController, MessagesController] })
export class EngagementModule {}
