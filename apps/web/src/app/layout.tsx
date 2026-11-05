import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { getLocale, getViewer } from '@/lib/server-api';
import './globals.css';

const inter = Inter({ subsets: ['latin', 'latin-ext'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Free Me', template: '%s - Free Me' },
  description: 'Watch and share videos from creators everywhere. Your content. Your freedom. Your opportunity.',
  applicationName: 'Free Me',
};
export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#ffffff' }, { media: '(prefers-color-scheme: dark)', color: '#0a1110' }],
  width: 'device-width', initialScale: 1,
};

/** Applies the device theme before the first paint when the visitor chose "use device theme". */
const THEME_SCRIPT = `try{var m=document.cookie.match(/(?:^|; )fm_theme=(light|dark|system)/);var t=m?m[1]:'system';if(t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [viewer, jar, locale] = await Promise.all([getViewer().catch(() => null), cookies(), getLocale()]);
  const theme = jar.get('fm_theme')?.value;
  return (
    <html lang={viewer?.profile?.preferredLanguage ?? 'en'} className={`${inter.variable} ${theme === 'dark' ? 'dark' : ''}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head>
      {/* Browser extensions (Grammarly, password managers…) add attributes to <body> before React loads. */}
      <body className="font-sans" suppressHydrationWarning>
        <AppShell viewer={viewer} locale={locale} sidebarCollapsed={jar.get('fm_sidebar')?.value === 'mini'}>{children}</AppShell>
      </body>
    </html>
  );
}
