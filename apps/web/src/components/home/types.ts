import type { VideoCardData } from '@/lib/types';

export interface HomeFeed {
  spotlight: (VideoCardData & { category: { slug: string; name: string } | null; channelFollowers: number }) | null;
  interests: Array<{ slug: string; name: string; picked: boolean }>;
  hasPicked: boolean;
  shelves: Array<{ category: { slug: string; name: string }; reason: 'picked' | 'popular'; videos: VideoCardData[] }>;
  fromCreators: VideoCardData[];
  moments: VideoCardData[];
  latest: VideoCardData[];
}
