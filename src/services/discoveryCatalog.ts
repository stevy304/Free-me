import type { Video } from '../types';
import { INITIAL_VIDEOS as sampleVideos } from './store';

const [city, tech, wildlife, music, coffee] = sampleVideos;
export const DISCOVERY_VIDEOS: Video[] = [
  { ...city, title: 'Evening in Kigali: Food, People and City Vibes', channelName: 'Kigali Walks', viewCount: 1200000, createdAt: '3 weeks ago', durationSeconds: 738 },
  { ...coffee, id: 'vid_coffee_journey', title: 'From Hill to Cup: Rwanda’s Coffee Journey', channelName: 'Rwanda Coffee Stories', isShort: false, viewCount: 420000, createdAt: '2 weeks ago', durationSeconds: 907 },
  { ...music, title: 'Afrobeat in Kigali: A Live Performance', channelName: 'AfroRwanda Live', viewCount: 869000, createdAt: '1 month ago', durationSeconds: 526 },
  { ...wildlife, title: 'Akagera National Park: Rwanda’s Wild Side', channelName: 'Wild Rwanda', viewCount: 536000, createdAt: '1 month ago', durationSeconds: 860 },
  { ...tech, title: 'Building in Kigali: How I’m Creating Tech for Africa', channelName: 'Kigali Tech Creator', viewCount: 284000, createdAt: '2 weeks ago', durationSeconds: 663 },
  { ...coffee, id: 'vid_rwandan_kitchen', title: 'A Modern Rwandan Kitchen: Tradition Meets Creativity', channelName: 'Chef Umuhoza', isShort: false, viewCount: 391000, createdAt: '2 weeks ago', durationSeconds: 627 },
  ...sampleVideos.filter((video) => video.isShort),
];
