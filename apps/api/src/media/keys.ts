import type { MediaLocation } from '@prisma/client';

/** Where a video's files live in storage. Media paths stored in the database are relative to mediaPrefix. */
export const sourceKey = (videoId: string, ext: string) => `src/${videoId}/source${ext}`;
export const mediaPrefix = (videoId: string, location: MediaLocation) => `${location === 'PUBLIC' ? 'pub' : 'prv'}/${videoId}/`;
export const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg',
  '.3gp': 'video/3gpp', '.ts': 'video/mp2t', '.mts': 'video/mp2t',
};
