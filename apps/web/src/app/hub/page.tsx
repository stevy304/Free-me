import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/server-api';
import { HubContent } from './HubContent';

export const metadata: Metadata = { title: 'Creator Hub' };

export default async function CreatorHub() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/hub');
  if (!viewer.channel) redirect('/channel/create');
  return <HubContent handle={viewer.channel.handle} />;
}
