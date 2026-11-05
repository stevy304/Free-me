import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/server-api';
import { CollectionsGrid } from './CollectionsGrid';

export const metadata: Metadata = { title: 'Collections' };

export default async function CollectionsPage() {
  if (!(await getViewer())) redirect('/login?returnTo=/collections');
  return <CollectionsGrid />;
}
