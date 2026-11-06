import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/server-api';
import { StudioLive } from '../studio/live/StudioLive';

export const metadata: Metadata = { title: 'Go live' };

export default async function GoLivePage() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/go-live');
  if (!viewer.channel) redirect('/channel/create');
  return <StudioLive basic />;
}
