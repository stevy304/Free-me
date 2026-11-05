import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/server-api';
import { StudioContent } from './StudioContent';

export const metadata: Metadata = { title: 'Your videos' };

export default async function Studio() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/studio');
  if (!viewer.channel) redirect('/channel/create');
  return <StudioContent handle={viewer.channel.handle} />;
}
