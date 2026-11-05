import * as Icon from '@/components/icons';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Avatar } from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { VideoGrid } from '@/components/video/VideoGrid';
import { apiGet, getViewer } from '@/lib/server-api';
import type { ChannelInfo, VideoPage } from '@/lib/types';

export const metadata: Metadata = { title: 'Following' };

export default async function FollowingPage() {
  if (!(await getViewer())) redirect('/login?returnTo=/following');
  const data = await apiGet<VideoPage & { channels: ChannelInfo[] }>('/feed/following');
  const channels = data?.channels ?? [];
  if (!channels.length) {
    return (
      <EmptyState icon={<Icon.Following size={36} strokeWidth={1.4} />} title="You are not following anyone yet"
        action={<Link href="/" className="inline-flex h-10 items-center rounded-full bg-strong px-5 text-[14px] font-medium text-on-strong">Find channels</Link>}>
        Follow channels you like and their new videos will appear here.
      </EmptyState>
    );
  }
  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="no-scrollbar -mx-1 flex gap-5 overflow-x-auto px-1 pb-4">
        {channels.map((c) => (
          <Link key={c.id} href={`/@${c.handle}`} className="flex w-20 shrink-0 flex-col items-center gap-2 text-center">
            <Avatar name={c.name} src={c.avatarUrl} size={64} /><span className="line-clamp-1 text-[12px]">{c.name}</span>
          </Link>
        ))}
      </div>
      <h1 className="mb-4 text-[20px] font-semibold">Latest</h1>
      {data!.videos.length ? <VideoGrid first={data!} endpoint="/feed/following" /> : <p className="py-10 text-center text-[15px] text-muted">The channels you follow have not published videos yet.</p>}
    </div>
  );
}
