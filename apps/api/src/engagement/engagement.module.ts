import { Module } from '@nestjs/common';
import { CollectionsController } from './collections.controller';
import { CommentsController } from './comments.controller';
import { ReactionsController } from './reactions.controller';

@Module({ controllers: [ReactionsController, CommentsController, CollectionsController] })
export class EngagementModule {}
