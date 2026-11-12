import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getViewer } from '@/lib/server-api';
import { siteInfo } from '../legal/site';
import { PlansView } from './PlansView';

export const metadata: Metadata = { title: 'Plans', description: 'Free Me plans: Plus without ads, Family & TV, Pro for creators, the Creator pass and Business.' };

export default async function PlansPage() {
  const [viewer, site] = await Promise.all([getViewer(), siteInfo()]);
  return <Suspense><PlansView signedIn={!!viewer} contactEmail={site.contactEmail} /></Suspense>;
}
