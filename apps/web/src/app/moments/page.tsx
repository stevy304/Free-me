import * as Icon from '@/components/icons';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/EmptyState';
import { apiGet } from '@/lib/server-api';
import type { VideoPage } from '@/lib/types';
import { MomentsFeed } from './MomentsFeed';

export const metadata: Metadata = { title: 'Moments' };

export default async function MomentsPage() {
  const page = await apiGet<VideoPage>('/videos?moments=true&limit=12');
  if (!page?.videos.length) return <EmptyState icon={<Icon.Moments size={36} strokeWidth={1.4} />} title="No Moments yet">Vertical videos up to 3 minutes become Moments and appear here as creators publish them.</EmptyState>;
  return <MomentsFeed first={page} />;
}
