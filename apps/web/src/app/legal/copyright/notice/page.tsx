import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { apiFetch, getViewer } from '@/lib/server-api';
import { NoticeForm } from './NoticeForm';

export const metadata: Metadata = { title: 'Copyright notice', robots: { index: false } };

export default async function NoticePage({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  const { v } = await searchParams;
  const back = `/legal/copyright/notice${v ? `?v=${encodeURIComponent(v)}` : ''}`;
  const viewer = await getViewer();
  if (!viewer) redirect(`/login?returnTo=${encodeURIComponent(back)}`);
  const video = v && /^[0-9a-f-]{36}$/i.test(v) ? (await apiFetch<{ video: { id: string; title: string; thumbnailUrl: string | null; channel: { name: string; handle: string } } }>(`/videos/${v}`)).data?.video ?? null : null;
  return <NoticeForm initialVideo={video} email={viewer.user.email} />;
}
