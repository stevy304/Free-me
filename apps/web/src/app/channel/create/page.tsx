import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/server-api';
import { CreateChannelForm } from './CreateChannelForm';

export const metadata: Metadata = { title: 'Create your Space' };

export default async function CreateChannel() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login?returnTo=/channel/create');
  if (viewer.channel) redirect(`/@${viewer.channel.handle}`);
  const suggested = (viewer.profile?.displayName ?? viewer.user.email.split('@')[0]);
  return <CreateChannelForm suggestedName={suggested} country={viewer.profile?.country ?? null} language={viewer.profile?.preferredLanguage ?? 'en'} avatarUrl={viewer.profile?.avatarUrl ?? null} />;
}
