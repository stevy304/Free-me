import type { MetadataRoute } from 'next';
import { apiGet, siteOrigin } from '@/lib/server-api';

/** Public videos and Spaces for search engines (unlisted and private videos are never listed). Refreshed hourly. */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteOrigin();
  const data = await apiGet<{ videos: Array<{ id: string; updatedAt: string; isShort: boolean }>; channels: Array<{ handle: string; updatedAt: string }> }>('/site/sitemap').catch(() => null);
  return [
    { url: `${origin}/`, changeFrequency: 'hourly', priority: 1 },
    { url: `${origin}/explore`, changeFrequency: 'hourly', priority: 0.8 },
    { url: `${origin}/moments`, changeFrequency: 'hourly', priority: 0.6 },
    ...(data?.channels ?? []).map((c) => ({ url: `${origin}/@${c.handle}`, lastModified: c.updatedAt, changeFrequency: 'daily' as const, priority: 0.6 })),
    ...(data?.videos ?? []).map((v) => ({ url: `${origin}/watch?v=${v.id}`, lastModified: v.updatedAt, changeFrequency: 'weekly' as const, priority: 0.7 })),
  ];
}
