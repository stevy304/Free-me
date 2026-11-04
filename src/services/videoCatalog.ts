import type { Video } from '../types';

export interface ReadyUpload {
  id: string;
  status: 'ready';
  visibility: 'private' | 'public';
  title: string;
  description: string;
  category: string;
  uploadedAt: string | null;
  durationSeconds: number | null;
  playlistUrl: string;
  thumbnailUrl: string | null;
}

export function toCatalogVideo(upload: ReadyUpload): Video {
  return {
    id: upload.id,
    channelId: 'local-uploads',
    channelName: 'Local uploads',
    channelHandle: '@local-uploads',
    channelAvatarUrl: '/free-me.svg',
    channelVerified: false,
    title: upload.title,
    description: upload.description,
    category: upload.category,
    tags: [],
    status: 'READY',
    visibility: upload.visibility === 'private' ? 'PRIVATE' : 'PUBLIC',
    durationSeconds: upload.durationSeconds ?? 0,
    thumbnailUrl: upload.thumbnailUrl ? '/api' + upload.thumbnailUrl : '',
    videoUrl: '/api' + upload.playlistUrl,
    isShort: false,
    monetizationEnabled: false,
    viewCount: 0,
    likeCount: 0,
    commentCount: 0,
    createdAt: upload.uploadedAt ? new Date(upload.uploadedAt).toLocaleDateString() : '',
    renditions: [],
  };
}
