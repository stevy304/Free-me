import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getViewer } from '@/lib/server-api';
import { ModerationQueue } from './ModerationQueue';
import { SafetyTerms } from './SafetyTerms';

export const metadata: Metadata = { title: 'Moderation', robots: { index: false } };

export default async function ModerationPage() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/moderation');
  if (!viewer.user.roles.some((r) => r === 'ADMIN' || r === 'MODERATOR')) notFound();
  return <><ModerationQueue /><div className="mx-auto max-w-5xl px-4 pb-16 sm:px-6"><SafetyTerms /></div></>;
}
