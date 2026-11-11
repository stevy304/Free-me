import { PlaybackHealthController } from './playback-health.controller';
import { Module } from '@nestjs/common';
import { CollectionsController } from './collections.controller';
import { CommentsController } from './comments.controller';
import { ReactionsController } from './reactions.controller';

@Module({ controllers: [PlaybackHealthController, ReactionsController, CommentsController, CollectionsController] })
export class EngagementModule {}
