import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getT, getViewer } from '@/lib/server-api';
import { PlansView } from './PlansView';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('plans.title'), description: t('meta.plansDesc') };
}

export default async function PlansPage() {
  const viewer = await getViewer();
  return <Suspense><PlansView signedIn={!!viewer} /></Suspense>;
}
