import type { VideoCardData } from '@/lib/types';

export interface HomeFeed {
  spotlight: (VideoCardData & { category: { slug: string; name: string } | null; channelFollowers: number }) | null;
  interests: Array<{ slug: string; name: string; picked: boolean }>;
  hasPicked: boolean;
  shelves: Array<{ category: { slug: string; name: string }; reason: 'picked' | 'popular'; videos: VideoCardData[] }>;
  continueWatching?: Array<{ video: VideoCardData; progressSeconds: number }>;
  fromCreators: VideoCardData[];
  /** Most watched in the last two days: from creators in the viewer's country (country set) or everywhere. */
  trending?: { country: string | null; videos: VideoCardData[] };
  moments: VideoCardData[];
  latest: VideoCardData[];
}
