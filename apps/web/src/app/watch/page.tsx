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
  const v = d.video;
  const description = (v.description?.replace(/\s+/g, ' ').trim() || `Watch ${v.title} from ${v.channel.name} on Free Me.`).slice(0, 200);
  const image = v.thumbnailUrl && v.visibility !== 'PRIVATE' ? [{ url: v.thumbnailUrl, width: 1280, height: 720, alt: v.title }] : undefined;
  const url = `/watch?v=${v.id}`;
  return {
    title: v.title, description,
    alternates: { canonical: url },
    // Unlisted and private videos are for people who have the link, not for search engines.
    robots: v.visibility === 'PUBLIC' ? undefined : { index: false, follow: false },
    openGraph: { type: 'video.other', url, title: v.title, description, siteName: 'Free Me', images: image },
    twitter: { card: image ? 'summary_large_image' : 'summary', title: v.title, description, images: image?.map((i) => i.url) },
  };
}

export default async function Watch({ searchParams }: { searchParams: Promise<{ v?: string; t?: string }> }) {
  const sp = await searchParams;
  const valid = !!sp.v && /^[0-9a-f-]{36}$/i.test(sp.v);
  // The video and what comes after it load together.
  const [r, more] = await Promise.all([load(sp.v), valid ? apiGet<{ videos: VideoPage['videos'] }>(`/videos/${sp.v}/next?limit=20`).catch(() => null) : null]);
  if (r?.status === 410) {
    return (
      <EmptyState icon={<Icon.Warning size={36} strokeWidth={1.4} />} title="Video unavailable" action={<Link href="/" className="inline-flex h-10 items-center rounded-xl bg-brand px-5 text-[14px] font-semibold text-on-brand">Go home</Link>}>
        {r.message} <Link href="/legal/guidelines" className="text-brand">How we decide</Link>
      </EmptyState>
    );
  }
  if (r && r.status >= 500) throw new Error(`API answered ${r.status}`);
  if (!r?.data) notFound();
  const d = r.data;
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
