import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getViewer } from '@/lib/server-api';
import { AdminConsole } from './AdminConsole';

export const metadata: Metadata = { title: 'Administration' };

export default async function Admin() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/admin');
  if (!viewer.user.roles.includes('ADMIN')) notFound();
  return <AdminConsole selfId={viewer.user.id} />;
}
