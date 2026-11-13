import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/server-api';
import { Inbox } from './Inbox';

export const metadata: Metadata = { title: 'Messages' };

export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ c?: string; to?: string }> }) {
  const sp = await searchParams;
  const back = `/messages${sp.to ? `?to=${encodeURIComponent(sp.to)}` : sp.c ? `?c=${encodeURIComponent(sp.c)}` : ''}`;
  if (!(await getViewer())) redirect(`/login?returnTo=${encodeURIComponent(back)}`);
  return <Inbox initialId={sp.c ?? null} to={sp.to ?? null} />;
}
