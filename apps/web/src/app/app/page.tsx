import type { Metadata } from 'next';
import { LogoMark, Wordmark } from '@/components/Logo';
import * as Icon from '@/components/icons';
import { apiGet } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Get the app', description: 'Free Me on your phone: the Android app, or Free Me on your iPhone home screen.' };

interface AndroidApp { available: boolean; version?: string; sizeBytes?: number; updatedAt?: string; downloadUrl?: string }

/** Free Me on a phone: the Android app (APK) to download, and the iPhone steps (Add to Home Screen). */
export default async function AppPage() {
  const android = (await apiGet<AndroidApp>('/app/android').catch(() => null)) ?? { available: false };
  const card = 'facet bg-elevated p-6';
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex items-center gap-3 text-ink"><LogoMark size={44} /><Wordmark className="text-[30px]" /></div>
      <h1 className="mt-5 text-[30px] font-extrabold leading-tight sm:text-[36px]">Free Me on your phone</h1>
      <div aria-hidden="true" className="zigzag mt-2 w-16" />
      <p className="mt-3 text-[15px] text-muted">Open Free Me from its own icon, full screen, like any app.</p>

      <div className="mt-7 grid gap-5 sm:grid-cols-2">
        <section className={card} aria-labelledby="android">
          <h2 id="android" className="flex items-center gap-2 text-[20px] font-bold"><Icon.Phone size={22} />Android</h2>
          {android.available ? (
            <>
              <a href={android.downloadUrl} download className="facet-sm mt-4 flex h-12 items-center justify-center gap-2 bg-brand px-5 text-[15px] font-semibold text-on-brand hover:bg-brand-strong">
                <Icon.Download size={20} />Download the app (APK)
              </a>
              <p className="mt-2 text-center text-[12px] text-muted">{android.version === 'latest' ? 'Latest version' : `Version ${android.version}`}{android.sizeBytes ? ` · ${(android.sizeBytes / 1024 / 1024).toFixed(1)} MB` : ''}</p>
              <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-[14px]">
                <li>Tap <b>Download</b>, then open the file when it finishes.</li>
                <li>If Android asks, allow your browser to <b>install unknown apps</b>.</li>
                <li>Tap <b>Install</b>. Free Me appears with your other apps.</li>
              </ol>
            </>
          ) : <p className="mt-3 text-[14px] text-muted">The Android app is coming soon. Until then, open Free Me in Chrome and choose <b>Install app</b> (or <b>Add to Home screen</b>) in the ⋮ menu.</p>}
        </section>
        <section className={card} aria-labelledby="iphone">
          <h2 id="iphone" className="flex items-center gap-2 text-[20px] font-bold"><Icon.Phone size={22} />iPhone and iPad</h2>
          <p className="mt-3 text-[14px] text-muted">iPhones cannot install APK files. Add Free Me to your home screen instead:</p>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[14px]">
            <li>Open Free Me in <b>Safari</b>.</li>
            <li>Tap <b>Share</b> (a square with an arrow).</li>
            <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
          </ol>
        </section>
      </div>
    </div>
  );
}
