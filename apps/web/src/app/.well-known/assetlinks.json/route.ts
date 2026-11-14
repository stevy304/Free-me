import { apiGet } from '@/lib/server-api';

/**
 * Digital Asset Links: tells Android that the Free Me app (its package and signing key, set in Administration →
 * Android app) belongs to this site, so the app opens the site full screen without an address bar.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const links = (await apiGet<unknown[]>('/app/android/assetlinks').catch(() => null)) ?? [];
  return Response.json(links, { headers: { 'Cache-Control': 'public, max-age=300' } });
}
