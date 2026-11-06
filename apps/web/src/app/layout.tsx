import type { Metadata, Viewport } from 'next';
import { Inter, Plus_Jakarta_Sans } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { getLocale, getViewer, siteOrigin } from '@/lib/server-api';
import './globals.css';

const inter = Inter({ subsets: ['latin', 'latin-ext'], variable: '--font-inter', display: 'swap' });
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin', 'latin-ext'], weight: ['600', '700', '800'], variable: '--font-jakarta', display: 'swap' });

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
    <html lang={viewer?.profile?.preferredLanguage ?? 'en'} className={`${inter.variable} ${jakarta.variable} ${theme === 'dark' ? 'dark' : ''}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head>
      {/* Browser extensions (Grammarly, password managers…) add attributes to <body> before React loads. */}
      <body className="font-sans" suppressHydrationWarning>
        <AppShell viewer={viewer} locale={locale}>{children}</AppShell>
      </body>
    </html>
  );
}
