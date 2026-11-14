/** Shapes the API returns (see apps/api). */
export type Role = 'VIEWER' | 'CREATOR' | 'ADVERTISER' | 'MODERATOR' | 'ADMIN';

export interface ChannelInfo {
  id: string; handle: string; name: string; description: string | null; avatarUrl: string | null; /** The Space shows its owner's profile picture (it has none of its own). */ avatarFromProfile?: boolean; bannerUrl: string | null;
  country: string | null; defaultLanguage: string | null; isVerified: boolean; badge?: 'verified' | 'premium' | null; followerCount: number; totalViews: string; createdAt: string;
}
export interface Profile { displayName: string; avatarUrl: string | null; bio: string | null; country: string | null; city: string | null; preferredLanguage: string; timezone: string | null; personalizedRecommendations?: boolean }
export interface Viewer {
  user: { id: string; email: string; roles: Role[]; status: string; createdAt: string; lastLoginAt: string | null };
  profile: Profile | null;
  channel: ChannelInfo | null;
  premium: { active: boolean; until: string | null; admin?: boolean };
}

export interface PayAccount { label: string; number: string; name: string }
export interface PayMethod { name: 'mtn_momo' | 'airtel_money' | 'flutterwave' | 'manual'; currency: string; perUsd: number; accounts?: PayAccount[]; instructions?: string | null }
/** One plan's price for this viewer (per month; the Creator pass per year) and the lengths on sale. */
export interface PlanPrice { usdCents: number; months: number[]; standardUsdCents?: number; country?: string | null }
export interface Plans { premium: PlanPrice; plus?: PlanPrice; family?: PlanPrice & { seats: number }; creatorPass?: PlanPrice & { freeVideos: number; videosPerYear?: number }; uploadMaxBytes?: number; ads: { usdCentsPer1000Views?: number; minBudgetUsdCents?: number; maxAdsPerVideo: number }; payoutMinimumUsdCents: number; methods: PayMethod[] }
export interface Payment {
  id: string; purpose: 'PREMIUM' | 'AD_CAMPAIGN' | 'CREATOR_SUPPORT' | 'CREATOR_PASS' | 'PLUS' | 'FAMILY' | 'VERIFICATION'; supportChannelId?: string | null; supportClearedAt?: string | null; method: PayMethod['name']; status: 'PENDING' | 'SUCCEEDED' | 'FAILED'; amount: string; currency: string; usdCents: number;
  months: number | null; campaignId: string | null; checkoutUrl: string | null; failureReason: string | null; createdAt: string; paidAt: string | null;
  /** Manual payments: the code to write in the transfer, and the transaction id the payer gave. */
  reference?: string | null; payerReference?: string | null;
}
export interface VideoCardData {
  id: string; title: string; thumbnailUrl: string | null; durationSeconds: number; isShort: boolean; viewCount: string; publishedAt: string | null;
  playbackUrl?: string | null; width?: number | null; height?: number | null;
  /** Seek-bar sprite sheet, for the hover preview on cards. */
  preview?: { url: string; count: number; cols: number; width: number; height: number } | null;
  channel: { handle: string; name: string; avatarUrl: string | null; isVerified: boolean; badge?: 'verified' | 'premium' | null };
  /** Moments feed only: what is shown over the Moment. */
  moment?: MomentDetails | null;
}
export type MomentSound = { kind: 'original' } | { kind: 'named'; title: string } | { kind: 'licensed'; title: string; owner: string };
export interface MomentDetails {
  description: string | null; tags: string[]; sound: MomentSound;
  /** An episode of a series: its number, how many are published, and the next one. */
  series: { id: string; title: string; episode: number; count: number; nextId: string | null } | null;
}
export interface VideoPage { videos: VideoCardData[]; nextCursor: string | null }
export interface Category { id: string; name: string; slug: string }
