import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { apiGet, getViewer } from '@/lib/server-api';
import type { VideoCardData } from '@/lib/types';
import type { CollectionSummary } from '@/components/engagement/SaveDialog';
import { CollectionView } from './CollectionView';

export interface CollectionPage { collection: CollectionSummary & { description: string | null }; isOwner: boolean; owner: { name: string; handle: string | null }; videos: VideoCardData[] }

const load = (id: string) => apiGet<CollectionPage>(`/collections/${encodeURIComponent(id)}`);

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const d = await load((await params).id);
  return d ? { title: d.collection.title, robots: d.collection.visibility === 'PUBLIC' ? undefined : { index: false } } : { title: 'Collection not available' };
}

export default async function CollectionRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === 'saved' && !(await getViewer())) redirect('/login?returnTo=/collection/saved');
  const d = await load(id);
  if (!d) notFound();
  return <CollectionView data={d} />;
}
