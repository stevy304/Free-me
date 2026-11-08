/** Shapes the API returns (see apps/api). */
export type Role = 'VIEWER' | 'CREATOR' | 'ADVERTISER' | 'MODERATOR' | 'ADMIN';

export interface ChannelInfo {
  id: string; handle: string; name: string; description: string | null; avatarUrl: string | null; bannerUrl: string | null;
  country: string | null; defaultLanguage: string | null; isVerified: boolean; followerCount: number; totalViews: string; createdAt: string;
}
export interface Profile { displayName: string; avatarUrl: string | null; bio: string | null; country: string | null; city: string | null; preferredLanguage: string; timezone: string | null }
export interface Viewer {
  user: { id: string; email: string; roles: Role[]; status: string; createdAt: string; lastLoginAt: string | null };
  profile: Profile | null;
  channel: ChannelInfo | null;
  premium: { active: boolean; until: string | null; admin?: boolean };
}

export interface PayAccount { label: string; number: string; name: string }
export interface PayMethod { name: 'mtn_momo' | 'flutterwave' | 'manual'; currency: string; perUsd: number; accounts?: PayAccount[]; instructions?: string | null }
export interface Plans { premium: { usdCents: number; months: number[] }; ads: { usdCentsPerDay: number; maxAdsPerVideo: number }; payoutMinimumUsdCents: number; methods: PayMethod[] }
export interface Payment {
  id: string; purpose: 'PREMIUM' | 'AD_CAMPAIGN' | 'AD_BADGE'; method: PayMethod['name']; status: 'PENDING' | 'SUCCEEDED' | 'FAILED'; amount: string; currency: string; usdCents: number;
  months: number | null; campaignId: string | null; checkoutUrl: string | null; failureReason: string | null; createdAt: string; paidAt: string | null;
  /** Manual payments: the code to write in the transfer, and the transaction id the payer gave. */
  reference?: string | null; payerReference?: string | null;
}
export interface VideoCardData {
  id: string; title: string; thumbnailUrl: string | null; durationSeconds: number; isShort: boolean; viewCount: string; publishedAt: string | null;
  playbackUrl?: string | null; width?: number | null; height?: number | null;
  channel: { handle: string; name: string; avatarUrl: string | null; isVerified: boolean };
}
export interface VideoPage { videos: VideoCardData[]; nextCursor: string | null }
export interface Category { id: string; name: string; slug: string }
