import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/server-api';
import { StudioLive } from './StudioLive';

export const metadata: Metadata = { title: 'Signal Room' };

export default async function LiveStudioPage() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/studio/live');
  if (!viewer.channel) redirect('/channel/create');
  return <StudioLive />;
}
