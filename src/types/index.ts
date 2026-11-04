/**
 * Free Me — Domain Types & Interfaces
 * Matches Prisma schema and platform business invariants
 */

export type Role = 'VIEWER' | 'CREATOR' | 'ADVERTISER' | 'ADMIN';

export type VideoStatus = 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED' | 'FLAGGED';

export type Visibility = 'PUBLIC' | 'UNLISTED' | 'PRIVATE';

export type AdFormat = 'PRE_ROLL' | 'MID_ROLL' | 'BANNER_DISPLAY' | 'SPONSORED_CARD';

export type CampaignStatus = 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'REJECTED';

export type PayoutStatus = 'REQUESTED' | 'UNDER_REVIEW' | 'APPROVED' | 'PAID' | 'REJECTED';

export type PayoutMethod = 'MTN_MOMO_RWANDA' | 'AIRTEL_MONEY_RWANDA' | 'BANK_TRANSFER_BK' | 'MPESA_KENYA';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  avatarUrl: string;
  country: string; // ISO 3166-1 alpha-2, e.g. "RW", "KE"
  city: string;
  channelId?: string;
  advertiserId?: string;
  createdAt: string;
}

export interface Channel {
  id: string;
  userId: string;
  handle: string; // e.g. "@clarisse_kigali"
  name: string;
  description: string;
  avatarUrl: string;
  bannerUrl: string;
  isVerified: boolean;
  subscriberCount: number;
  totalViews: number;
  isMonetized: boolean;
  watchHours: number;
  country: string;
  joinedDate: string;
}

export interface VideoRendition {
  resolution: '1080p' | '720p' | '480p' | '360p';
  width: number;
  height: number;
  bitrateKbps: number;
  label: string;
}

export interface Video {
  id: string;
  channelId: string;
  channelName: string;
  channelHandle: string;
  channelAvatarUrl: string;
  channelVerified: boolean;
  title: string;
  description: string;
  category: string;
  tags: string[];
  status: VideoStatus;
  visibility: Visibility;
  durationSeconds: number;
  thumbnailUrl: string;
  videoUrl: string; // HLS stream or video media source
  isShort: boolean;
  monetizationEnabled: boolean;
  viewCount: number;
  likeCount: number;
  isLiked?: boolean;
  isDisliked?: boolean;
  commentCount: number;
  createdAt: string;
  renditions: VideoRendition[];
  soundTitle?: string;
}

export interface Comment {
  id: string;
  videoId: string;
  userId: string;
  userName: string;
  userAvatar: string;
  content: string;
  likeCount: number;
  isLiked?: boolean;
  createdAt: string;
  replies?: Comment[];
}

export interface Campaign {
  id: string;
  advertiserId: string;
  businessName: string;
  name: string;
  adFormat: AdFormat;
  status: CampaignStatus;
  budgetAmountRwf: number;
  spentAmountRwf: number;
  targetCountry: string;
  targetCategory: string;
  cpmRateRwf: number; // Cost per 1000 views in RWF (e.g. 5,000 RWF ≈ $3.80)
  adCreativeUrl: string;
  destinationUrl: string;
  headline: string;
  callToAction: string;
  impressionsCount: number;
  clicksCount: number;
  startDate: string;
  endDate: string;
}

export interface RevenueLedgerEntry {
  id: string;
  channelId: string;
  channelName: string;
  sourceType: 'PRE_ROLL_AD_SHARE' | 'BANNER_AD_SHARE' | 'CREATOR_GRANT' | 'PAYOUT_DEDUCTION';
  referenceId?: string;
  grossAmountRwf: number;
  creatorShareRwf: number; // 60%
  platformShareRwf: number; // 30%
  reinvestShareRwf: number; // 10%
  balanceAfterRwf: number;
  description: string;
  createdAt: string;
}

export interface CreatorBalance {
  channelId: string;
  pendingBalanceRwf: number;
  confirmedBalanceRwf: number;
  lifetimeEarningsRwf: number;
  withdrawnRwf: number;
}

export interface PayoutRequest {
  id: string;
  channelId: string;
  channelName: string;
  amountRwf: number;
  currency: 'RWF' | 'USD';
  method: PayoutMethod;
  accountIdentifier: string; // Phone number or Bank account
  accountHolderName: string;
  status: PayoutStatus;
  requestedAt: string;
  processedAt?: string;
  rejectionReason?: string;
}

export interface PlatformSettings {
  creatorPoolPercent: number; // Default 60
  platformOpsPercent: number; // Default 30
  reinvestmentPercent: number; // Default 10
  minPayoutThresholdRwf: number; // 10,000 RWF
  exchangeRateRwfPerUsd: number; // 1320 RWF = $1
  monetizationSubsRequired: number; // 1000
  monetizationHoursRequired: number; // 4000
}

export interface AuditLogItem {
  id: string;
  timestamp: string;
  adminName: string;
  action: string;
  entityType: string;
  entityId: string;
  details: string;
}

export interface ModerationReport {
  id: string;
  videoId: string;
  videoTitle: string;
  reporterName: string;
  reason: 'COPYRIGHT' | 'INAPPROPRIATE' | 'MISINFORMATION' | 'SPAM';
  details: string;
  status: 'PENDING' | 'RESOLVED' | 'DISMISSED';
  createdAt: string;
}
