import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/server-api';
import { HistoryList } from './HistoryList';

export const metadata: Metadata = { title: 'History' };

export default async function HistoryPage() {
  if (!(await getViewer())) redirect('/login?returnTo=/history');
  return <HistoryList />;
}
