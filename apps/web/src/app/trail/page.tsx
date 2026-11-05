import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/server-api';
import { HistoryList } from './HistoryList';

export const metadata: Metadata = { title: 'Trail' };

export default async function TrailPage() {
  if (!(await getViewer())) redirect('/login?returnTo=/trail');
  return <HistoryList />;
}
