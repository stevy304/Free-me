import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Offline', robots: { index: false } };
export const dynamic = 'force-static';

/** Shown by the installed app when there is no connection (kept by the service worker). */
export default function Offline() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/free-me.svg" alt="" width={64} height={64} />
      <h1 className="font-display text-[26px] font-extrabold">You are offline</h1>
      <p className="text-[15px] text-muted">Free Me needs a connection to play videos. Check your mobile data or Wi-Fi, then try again.</p>
      <a href="/" className="flex h-11 items-center rounded-2xl bg-brand px-5 text-[14px] font-bold text-on-brand">Try again</a>
    </div>
  );
}
