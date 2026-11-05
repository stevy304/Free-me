import { Clapperboard } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/EmptyState';
import { apiGet } from '@/lib/server-api';
import type { VideoPage } from '@/lib/types';
import { ShortsFeed } from './ShortsFeed';

export const metadata: Metadata = { title: 'Shorts' };

export default async function Shorts() {
  const page = await apiGet<VideoPage>('/videos?shorts=true&limit=12');
  if (!page?.videos.length) return <EmptyState icon={<Clapperboard size={36} strokeWidth={1.4} />} title="No Shorts yet">Vertical videos up to 3 minutes become Shorts and appear here as creators publish them.</EmptyState>;
  return <ShortsFeed first={page} />;
}
