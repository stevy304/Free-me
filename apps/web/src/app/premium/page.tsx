import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { getViewer } from '@/lib/server-api';
import { PremiumView } from './PremiumView';

export const metadata: Metadata = { title: 'Premium', description: 'Free Me Premium: a verified badge, earnings from your videos and Live Studio.' };

export default async function Premium() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/premium');
  return <Suspense><PremiumView viewer={viewer} /></Suspense>;
}
