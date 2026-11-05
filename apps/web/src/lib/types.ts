/** Shapes the API returns (see apps/api). */
export type Role = 'VIEWER' | 'CREATOR' | 'ADVERTISER' | 'MODERATOR' | 'ADMIN';

export interface ChannelInfo {
  id: string; handle: string; name: string; description: string | null; avatarUrl: string | null; bannerUrl: string | null;
  country: string | null; defaultLanguage: string | null; isVerified: boolean; subscriberCount: number; totalViews: string; createdAt: string;
}
export interface Profile { displayName: string; avatarUrl: string | null; bio: string | null; country: string | null; city: string | null; preferredLanguage: string; timezone: string | null }
export interface Viewer {
  user: { id: string; email: string; roles: Role[]; status: string; createdAt: string; lastLoginAt: string | null };
  profile: Profile | null;
  channel: ChannelInfo | null;
}
export interface VideoCardData {
  id: string; title: string; thumbnailUrl: string | null; durationSeconds: number; isShort: boolean; viewCount: string; publishedAt: string | null;
  playbackUrl?: string | null; width?: number | null; height?: number | null;
  channel: { handle: string; name: string; avatarUrl: string | null; isVerified: boolean };
}
export interface VideoPage { videos: VideoCardData[]; nextCursor: string | null }
export interface Category { id: string; name: string; slug: string }
