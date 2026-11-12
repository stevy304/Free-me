import type { Channel, Prisma, Video } from '@prisma/client';
import type { MediaUrls } from '../videos/media-urls';

/**
 * The badge a Space shows: "verified" when Free Me checked who it is (an administrator set it), "premium" when it comes
 * with a Premium membership. They look different, so a paid badge is never mistaken for a checked identity.
 */
export const badgeOf = (c: Pick<Channel, 'isVerified' | 'verificationSource'>): 'verified' | 'premium' | null =>
  !c.isVerified ? null : c.verificationSource === 'PREMIUM' ? 'premium' : 'verified';

/** A video as it appears in grids and lists (only public, ready videos with public media are ever listed). */
export const videoCard = (v: Video & { channel: Channel }, urls: MediaUrls) => ({
  id: v.id, title: v.title, thumbnailUrl: urls.publicThumb(v), durationSeconds: v.durationSeconds, isShort: v.isShort,
  viewCount: v.viewCount.toString(), publishedAt: v.publishedAt, playbackUrl: urls.playback(v), width: v.width, height: v.height,
  channel: { handle: v.channel.handle, name: v.channel.name, avatarUrl: v.channel.avatarUrl, isVerified: v.channel.isVerified, badge: badgeOf(v.channel) },
});

export const PUBLIC_VIDEO = { status: 'READY', visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: { not: null }, takenDownAt: null, reviewHoldAt: null, isAd: false } as const;

/** Videos anyone with the link may watch: public or unlisted, ready, not removed. */
export const LINKED_VIDEO: Prisma.VideoWhereInput = { status: 'READY', visibility: { in: ['PUBLIC', 'UNLISTED'] }, takenDownAt: null, reviewHoldAt: null };
