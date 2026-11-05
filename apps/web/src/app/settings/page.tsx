import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { apiGet, getViewer } from '@/lib/server-api';
import { Settings } from './Settings';

export const metadata: Metadata = { title: 'Settings' };

export interface SessionRow { id: string; method: string; userAgent: string | null; ipAddress: string | null; createdAt: string; lastSeenAt: string; current: boolean }

export default async function SettingsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/settings');
  const sessions = (await apiGet<{ sessions: SessionRow[] }>('/me/sessions'))?.sessions ?? [];
  return <Settings viewer={viewer} sessions={sessions} />;
}
