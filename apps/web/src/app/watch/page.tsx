import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import * as Icon from '@/components/icons';
import { EmptyState } from '@/components/EmptyState';
import { apiFetch, apiGet } from '@/lib/server-api';
import type { VideoPage } from '@/lib/types';
import { WatchView, type WatchVideo, type WatchViewer } from './WatchView';

type Loaded = Awaited<ReturnType<typeof apiFetch<{ video: WatchVideo; viewer: WatchViewer }>>>;
const load = (id?: string): Promise<Loaded | null> => (id && /^[0-9a-f-]{36}$/i.test(id) ? apiFetch<{ video: WatchVideo; viewer: WatchViewer }>(`/videos/${id}`) : Promise.resolve(null));

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ v?: string }> }): Promise<Metadata> {
  const r = await load((await searchParams).v);
  const d = r?.data;
  if (!d) return { title: r?.status === 410 ? 'Video removed' : 'Video not available', robots: { index: false } };
  return { title: d.video.title, description: d.video.description?.slice(0, 160), openGraph: { title: d.video.title, type: 'video.other', images: d.video.thumbnailUrl && d.video.visibility !== 'PRIVATE' ? [d.video.thumbnailUrl] : undefined } };
}

export default async function Watch({ searchParams }: { searchParams: Promise<{ v?: string; t?: string }> }) {
  const sp = await searchParams;
  const r = await load(sp.v);
  if (r?.status === 410) {
    return (
      <EmptyState icon={<Icon.Warning size={36} strokeWidth={1.4} />} title="Video unavailable" action={<Link href="/" className="inline-flex h-10 items-center rounded-full bg-brand px-5 text-[14px] font-semibold text-on-brand">Go home</Link>}>
        {r.message} <Link href="/legal/guidelines" className="text-brand">How we decide</Link>
      </EmptyState>
    );
  }
  if (r && r.status >= 500) throw new Error(`API answered ${r.status}`);
  if (!r?.data) notFound();
  const d = r.data;
  const more = await apiGet<VideoPage>('/videos?limit=20&moments=false');
  // ?t=90 (or 1m30s) starts at that moment, e.g. from a shared link or a report.
  const t = parseStart(sp.t);
  return <WatchView v={d.video} viewer={t ? { ...d.viewer, resumeAt: t } : d.viewer} more={(more?.videos ?? []).filter((x) => x.id !== d.video.id)} />;
}

function parseStart(t?: string): number {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}
