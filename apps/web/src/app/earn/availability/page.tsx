import type { Metadata } from 'next';
import Link from 'next/link';
import { apiGet } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Creator payout availability' };

export default async function PayoutAvailability() {
  const data = await apiGet<{ countries: Array<{ code: string; name: string; currency: string; method: string; quotesEnabled: boolean }>; otherCountries: string }>('/monetisation/availability');
  return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
    <p className="text-sm font-semibold text-brand">Free Me creators</p>
    <h1 className="mt-2 text-3xl font-extrabold">Where can I receive payouts?</h1>
    <p className="mt-4 text-muted">Payout availability depends on the destination country and payment route. Check this page before joining the earning programme. Premium membership and payout account review are separate.</p>
    <div className="mt-6 space-y-4">
      {data?.countries.map((c) => <article key={c.code} className="rounded-3xl border border-line bg-elevated p-5">
        <h2 className="text-xl font-bold">{c.name}</h2>
        <p className="mt-2">{c.method} · {c.currency}</p>
        <p className="mt-2 text-sm text-muted">Pilot with account ownership review and manually processed withdrawals.</p>
        <p className="mt-2 text-sm font-semibold">{c.quotesEnabled ? 'Withdrawal previews enabled' : 'Withdrawal previews awaiting operator setup'}</p>
        <p className="mt-2 text-sm text-muted">Your preview shows the rate, fee and amount to receive before you confirm. Processing time is confirmed by the Free Me team.</p>
      </article>)}
      {!data && <p role="status">Availability could not be loaded. Check again before requesting a payout.</p>}
    </div>
    <p className="mt-6 text-sm text-muted">{data?.otherCountries ?? 'Contact Free Me to confirm support for your country.'}</p>
    <Link href="/hub?tab=money" className="mt-6 inline-block rounded-xl bg-brand px-4 py-3 text-sm font-bold text-on-brand">Open Creator Hub</Link>
  </main>;
}
