import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { getLocale, getViewer, siteOrigin } from '@/lib/server-api';
import './fonts/fonts.css';
import './globals.css';

const DESCRIPTION = 'Watch and share videos from creators everywhere. Your content. Your freedom. Your opportunity.';

/** Absolute addresses for link previews (WhatsApp, X, Facebook...) come from the site's public origin. */
export async function generateMetadata(): Promise<Metadata> {
  return {
    metadataBase: new URL(await siteOrigin()),
    title: { default: 'Free Me', template: '%s - Free Me' },
    description: DESCRIPTION,
    applicationName: 'Free Me',
    // Added to an iPhone home screen: opens full screen with the Free Me name.
    appleWebApp: { capable: true, title: 'Free Me', statusBarStyle: 'default' },
    openGraph: { siteName: 'Free Me', type: 'website', title: 'Free Me', description: DESCRIPTION, images: [{ url: '/apple-icon.png', width: 180, height: 180, alt: 'Free Me' }] },
    twitter: { card: 'summary', title: 'Free Me', description: DESCRIPTION },
  };
}
export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f7f5ef' }, { media: '(prefers-color-scheme: dark)', color: '#0a1110' }],
  width: 'device-width', initialScale: 1,
};

/** Applies the device theme before the first paint when the visitor chose "use device theme". */
const THEME_SCRIPT = `try{var m=document.cookie.match(/(?:^|; )fm_theme=(light|dark|system)/);var t=m?m[1]:'system';if(t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [viewer, jar, locale] = await Promise.all([getViewer().catch(() => null), cookies(), getLocale()]);
  const theme = jar.get('fm_theme')?.value;
  return (
    <html lang={viewer?.profile?.preferredLanguage ?? 'en'} className={theme === 'dark' ? 'dark' : undefined} suppressHydrationWarning>
      <head>
        {/* Private preview tunnels need their session cookie on manifest requests. */}
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      {/* Browser extensions (Grammarly, password managers…) add attributes to <body> before React loads. */}
      <body className="font-sans" suppressHydrationWarning>
        <AppShell viewer={viewer} locale={locale}>{children}</AppShell>
      </body>
    </html>
  );
}
