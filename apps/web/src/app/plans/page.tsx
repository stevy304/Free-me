import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getViewer } from '@/lib/server-api';
import { PlansView } from './PlansView';

export const metadata: Metadata = { title: 'Plans', description: 'Free Me plans for viewers (Free, Plus, Family & TV) and for creators (Starter, Creator pass, Pro).' };

export default async function PlansPage() {
  const viewer = await getViewer();
  return <Suspense><PlansView signedIn={!!viewer} /></Suspense>;
}
