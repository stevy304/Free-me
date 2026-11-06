import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { apiGet } from '@/lib/server-api';
import { LiveView } from './LiveView';
import type { LiveInfo } from '../types';
import type { ChatLine } from '@/components/live/LiveChat';

type Props = { params: Promise<{ id: string }> };
const get = (id: string) => (/^[0-9a-f-]{36}$/.test(id) ? apiGet<{ stream: LiveInfo; chat: ChatLine[] }>(`/live/${id}`) : Promise.resolve(null));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await get((await params).id);
  return r ? { title: `${r.stream.status === 'LIVE' ? '🔴 ' : ''}${r.stream.title}`, description: `${r.stream.channel.name} on Free Me` } : { title: 'Live' };
}

export default async function LivePage({ params }: Props) {
  const r = await get((await params).id);
  if (!r) notFound();
  return <LiveView initial={r.stream} chat={r.chat} />;
}
