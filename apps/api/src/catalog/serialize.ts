import type { Channel, Video } from '@prisma/client';

/** A video as it appears in grids and lists (only public, ready videos are ever listed). */
export const videoCard = (v: Video & { channel: Channel }) => ({
  id: v.id, title: v.title, thumbnailUrl: v.thumbnailUrl, durationSeconds: v.durationSeconds, isShort: v.isShort,
  viewCount: v.viewCount.toString(), publishedAt: v.publishedAt,
  channel: { handle: v.channel.handle, name: v.channel.name, avatarUrl: v.channel.avatarUrl, isVerified: v.channel.isVerified },
});

export const PUBLIC_VIDEO = { status: 'READY', visibility: 'PUBLIC', publishedAt: { not: null } } as const;
