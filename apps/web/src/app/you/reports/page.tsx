import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import * as Icon from '@/components/icons';
import { EmptyState } from '@/components/EmptyState';
import { apiGet, getLocale, getViewer } from '@/lib/server-api';
import { fullDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Your reports', robots: { index: false } };

interface Report { id: string; reason: string; reasonLabel: string; status: 'PENDING' | 'INVESTIGATING' | 'RESOLVED' | 'DISMISSED'; resolution: string | null; createdAt: string; resolvedAt: string | null; video: { id: string; title: string } }
const STATUS = { PENDING: ['Waiting for review', 'bg-surface'], INVESTIGATING: ['Being reviewed', 'bg-brand-soft text-brand'], RESOLVED: ['Action taken', 'bg-brand-soft text-brand'], DISMISSED: ['No action', 'bg-surface text-muted'] } as const;

export default async function YourReports() {
  if (!(await getViewer())) redirect('/login?returnTo=/you/reports');
  const [data, locale] = await Promise.all([apiGet<{ reports: Report[] }>('/me/reports'), getLocale()]);
  const reports = data?.reports ?? [];
  if (!reports.length) return <EmptyState icon={<Icon.Flag size={36} strokeWidth={1.4} />} title="No reports">When you report a video or send a copyright notice, you can follow what happens to it here.</EmptyState>;
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-[28px] font-bold">Your reports</h1>
      <p className="text-[14px] text-muted">Reports are confidential. The creator is not told who reported their video, except the name in a copyright notice, which the law requires.</p>
      <ul className="mt-6 divide-y divide-line rounded-2xl border border-line">
        {reports.map((r) => {
          const [label, cls] = STATUS[r.status];
          return (
            <li key={r.id} className="flex flex-col gap-1 p-4 text-[14px] sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <Link href={`/watch?v=${r.video.id}`} className="font-medium hover:underline">{r.video.title}</Link>
                <p className="text-muted">{r.reasonLabel} · sent {fullDate(r.createdAt, locale)}</p>
                {r.resolution && <p className="mt-1">{r.resolution}</p>}
              </div>
              <span className={`shrink-0 self-start rounded-full px-3 py-1 text-[12px] font-semibold ${cls}`}>{label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
