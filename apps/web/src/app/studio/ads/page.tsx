import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { getViewer } from '@/lib/server-api';
import { AdStudio } from './AdStudio';

export const metadata: Metadata = { title: 'Ad Studio', description: 'Upload video ads and run them midway through eligible videos on Free Me, by the day.' };

export default async function AdStudioPage() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/studio/ads');
  return <Suspense><AdStudio viewer={viewer} /></Suspense>;
}
