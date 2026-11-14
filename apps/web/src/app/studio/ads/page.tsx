import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { getViewer } from '@/lib/server-api';
import { AdStudio } from './AdStudio';

export const metadata: Metadata = { title: 'Ad Studio', description: 'Start a small video advertising campaign on Free Me. Set a total budget and pay for ad impressions.' };

export default async function AdStudioPage() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/studio/ads');
  return <Suspense><AdStudio viewer={viewer} /></Suspense>;
}
