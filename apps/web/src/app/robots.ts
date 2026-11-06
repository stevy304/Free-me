import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/lib/server-api';

/** Search engines may read public pages; personal and tool pages stay out. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await siteOrigin();
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/hub', '/admin', '/moderation', '/login', '/settings', '/trail', '/you', '/collections', '/following'] },
    sitemap: `${origin}/sitemap.xml`,
  };
}
