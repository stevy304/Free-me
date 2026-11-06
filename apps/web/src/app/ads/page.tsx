import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { getViewer } from '@/lib/server-api';
import { AdsManager } from './AdsManager';

export const metadata: Metadata = { title: 'Ads Manager', description: 'Promote your business on Free Me with a short video ad, by the day.' };

export default async function Ads() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/ads');
  return <Suspense><AdsManager viewer={viewer} /></Suspense>;
}
