import { Inject, Injectable } from '@nestjs/common';
import type { Video } from '@prisma/client';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { mediaPrefix } from '../media/keys';
import { STORAGE } from '../media/queue';
import type { Storage } from '../media/storage';

/**
 * Turns storage keys into links. Public and unlisted media come from the CDN (cacheable, fast everywhere);
 * private media only through short-lived signed links or the API's checked playlist route.
 */
@Injectable()
export class MediaUrls {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig, @Inject(STORAGE) private readonly storage: Storage) {}

  publicUrl(videoId: string, rel: string) { return `${this.config.media.publicBaseUrl}/${videoId}/${rel}`; }

  /** Thumbnail for grids (only videos whose media is public are listed). */
  publicThumb(v: Pick<Video, 'id' | 'thumbnailKey' | 'mediaLocation'>): string | null {
    return v.thumbnailKey && v.mediaLocation === 'PUBLIC' ? this.publicUrl(v.id, v.thumbnailKey) : null;
  }
  /** The 480-pixel copy for lists (null when there is none: the full thumbnail is used). */
  publicThumbSmall(v: Pick<Video, 'id' | 'thumbnailSmallKey' | 'mediaLocation'>): string | null {
    return v.thumbnailSmallKey && v.mediaLocation === 'PUBLIC' ? this.publicUrl(v.id, v.thumbnailSmallKey) : null;
  }

  async thumb(v: Pick<Video, 'id' | 'thumbnailKey' | 'mediaLocation'>): Promise<string | null> {
    return v.thumbnailKey ? this.file(v, v.thumbnailKey) : null;
  }

  /** Any file of a video (thumbnail candidates, ...) for someone allowed to see it. */
  async file(v: Pick<Video, 'id' | 'mediaLocation'>, rel: string): Promise<string> {
    return v.mediaLocation === 'PUBLIC' ? this.publicUrl(v.id, rel) : this.storage.signedGetUrl(mediaPrefix(v.id, v.mediaLocation) + rel, 4 * 3600);
  }

  /**
   * Where the player loads the master playlist. Private media goes through the API, which checks access. With `full`
   * (Premium viewers, the owner) every quality; otherwise up to FREE_MAX_QUALITY when the video has a limited playlist.
   */
  playback(v: Pick<Video, 'id' | 'hlsMasterKey' | 'mediaLocation' | 'status'> & Partial<Pick<Video, 'hlsFullMasterKey'>>, full = false): string | null {
    if (v.status !== 'READY' || !v.hlsMasterKey) return null;
    const key = full && v.hlsFullMasterKey ? v.hlsFullMasterKey : v.hlsMasterKey;
    return v.mediaLocation === 'PUBLIC' ? this.publicUrl(v.id, key) : `/api/videos/${v.id}/${key}`;
  }

  /** The highest quality free viewers get for this video (e.g. 720), or null when they get every quality. */
  qualityLimit(v: Partial<Pick<Video, 'hlsFullMasterKey'>>): number | null {
    return v.hlsFullMasterKey && this.config.media.freeMaxShort ? this.config.media.freeMaxShort : null;
  }
}
