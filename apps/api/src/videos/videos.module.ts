import { Global, Module } from '@nestjs/common';
import { MediaQueue, storageProvider } from '../media/queue';
import { LocalStorageController } from './local-storage.controller';
import { MediaUrls } from './media-urls';
import { PlaybackController } from './playback.controller';
import { HubController } from './hub.controller';
import { UploadsController } from './uploads.controller';

@Global()
@Module({
  controllers: [UploadsController, HubController, PlaybackController, LocalStorageController],
  providers: [storageProvider, MediaQueue, MediaUrls],
  exports: [storageProvider, MediaQueue, MediaUrls],
})
export class VideosModule {}
