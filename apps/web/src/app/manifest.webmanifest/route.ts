import type { MetadataRoute } from 'next';

/** Free Me as an installed app: its own icon on the home screen, full screen, opens on the home feed. */
export const dynamic = 'force-static';

export function GET() {
  const manifest: MetadataRoute.Manifest = {
    id: '/',
    name: 'Free Me',
    short_name: 'Free Me',
    description: 'Watch and share videos from creators everywhere. Your content. Your freedom. Your opportunity.',
    start_url: '/?source=app',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#14110f',
    theme_color: '#14110f',
    categories: ['entertainment', 'video', 'social'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/free-me.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    shortcuts: [
      { name: 'Moments', url: '/moments?source=app', icons: [{ src: '/icons/shortcut-upload.png', sizes: '96x96', type: 'image/png' }] },
      { name: 'Following', url: '/following?source=app', icons: [{ src: '/icons/shortcut-upload.png', sizes: '96x96', type: 'image/png' }] },
      { name: 'Creator Hub', url: '/hub?source=app', icons: [{ src: '/icons/shortcut-upload.png', sizes: '96x96', type: 'image/png' }] },
    ],
  };
  return Response.json(manifest, { headers: { 'Content-Type': 'application/manifest+json' } });
}
