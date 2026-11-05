import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getViewer } from '@/lib/server-api';
import { ModerationQueue } from './ModerationQueue';

export const metadata: Metadata = { title: 'Moderation', robots: { index: false } };

export default async function ModerationPage() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/moderation');
  if (!viewer.user.roles.some((r) => r === 'ADMIN' || r === 'MODERATOR')) notFound();
  return <ModerationQueue />;
}
