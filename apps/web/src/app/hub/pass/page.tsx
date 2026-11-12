import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { getViewer } from '@/lib/server-api';
import { PassView } from './PassView';

export const metadata: Metadata = { title: 'Creator pass' };

export default async function CreatorPass() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/hub/pass');
  if (!viewer.channel) redirect('/channel/create');
  return <Suspense><PassView /></Suspense>;
}
