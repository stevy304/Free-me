import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { getT, getViewer } from '@/lib/server-api';
import { PremiumView } from './PremiumView';

export async function generateMetadata(): Promise<Metadata> { return { title: 'Premium', description: (await getT())('meta.premiumDesc') }; }

export default async function Premium() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/premium');
  return <Suspense><PremiumView viewer={viewer} /></Suspense>;
}
