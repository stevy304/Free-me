export interface HubVideo {
  id: string; title: string; description: string | null; visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE'; status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED' | 'FLAGGED' | 'SUSPENDED';
  madeForKids: boolean; isShort: boolean; isPodcast?: boolean; isAd?: boolean; language: string | null; category: { slug: string; name: string } | null; tags: string[];
  durationSeconds: number; width: number | null; height: number | null; processingProgress: number; processingStage: string | null; processingError: string | null;
  viewCount: string; likeCount: number; dislikeCount: number; commentCount: number; commentsEnabled: boolean; createdAt: string; publishedAt: string | null;
  takenDownAt: string | null; takedownReason: string | null;
  /** The automatic (AI) decision, when it was not a plain publish: the reason is written for the creator. */
  safety?: { decision: 'publish' | 'limit' | 'reject' | null; reason: string | null; limited: boolean; appealedAt: string | null; canAppeal: boolean };
  thumbnailUrl: string | null; customThumbnail: boolean; thumbnailCandidates: string[]; renditions: string[];
  captions?: Array<{ language: string; source: 'UPLOADED' | 'AUTO'; cues: number; updatedAt: string; url: string }>; playbackUrl: string | null; sourceSizeBytes: string | null;
}
