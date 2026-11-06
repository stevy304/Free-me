import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/server-api';
import { JoinBroadcast } from './JoinBroadcast';

export default async function JoinBroadcastPage({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  const { invite } = await searchParams;
  if (!invite || !/^[A-Za-z0-9_-]{32}$/.test(invite)) return <p className="mx-auto max-w-xl p-6">This broadcast invitation is invalid.</p>;
  if (!await getViewer()) redirect(`/login?returnTo=${encodeURIComponent(`/live/join?invite=${invite}`)}`);
  return <JoinBroadcast invite={invite} />;
}
