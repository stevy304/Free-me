export interface StudioVideo {
  id: string; title: string; description: string | null; visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE'; status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED' | 'FLAGGED' | 'SUSPENDED';
  madeForKids: boolean; isShort: boolean; language: string | null; category: { slug: string; name: string } | null; tags: string[];
  durationSeconds: number; width: number | null; height: number | null; processingProgress: number; processingStage: string | null; processingError: string | null;
  viewCount: string; likeCount: number; commentCount: number; createdAt: string; publishedAt: string | null;
  thumbnailUrl: string | null; customThumbnail: boolean; thumbnailCandidates: string[]; renditions: string[]; playbackUrl: string | null; sourceSizeBytes: string | null;
}
