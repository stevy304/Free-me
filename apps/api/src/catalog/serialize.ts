import type { Channel, Video } from '@prisma/client';
import type { MediaUrls } from '../videos/media-urls';

/** A video as it appears in grids and lists (only public, ready videos with public media are ever listed). */
export const videoCard = (v: Video & { channel: Channel }, urls: MediaUrls) => ({
  id: v.id, title: v.title, thumbnailUrl: urls.publicThumb(v), durationSeconds: v.durationSeconds, isShort: v.isShort,
  viewCount: v.viewCount.toString(), publishedAt: v.publishedAt, playbackUrl: urls.playback(v), width: v.width, height: v.height,
  channel: { handle: v.channel.handle, name: v.channel.name, avatarUrl: v.channel.avatarUrl, isVerified: v.channel.isVerified },
});

export const PUBLIC_VIDEO = { status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: { not: null } } as const;
