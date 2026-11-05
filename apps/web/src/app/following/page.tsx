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

/** Following: the Spaces you tune in to, then everything they publish, newest first (no ranking). */
export default async function FollowingPage() {
  if (!(await getViewer())) redirect('/login?returnTo=/following');
  const data = await apiGet<VideoPage & { channels: ChannelInfo[] }>('/feed/following');
  const channels = data?.channels ?? [];
  if (!channels.length) {
    return (
      <EmptyState icon={<Icon.Following size={36} strokeWidth={1.4} />} title="You haven't tuned in to anyone yet"
        action={<Link href="/explore" className="inline-flex h-10 items-center rounded-xl bg-brand px-5 text-[14px] font-semibold text-on-brand">Explore creators</Link>}>
        Tune in to a Space and every new video from it appears here, in the order it was published.
      </EmptyState>
    );
  }
  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6">
      <h1 className="text-[30px] font-extrabold">Following</h1>
      <p className="mt-1 text-[14px] text-muted">Everything from the Spaces you tune in to, newest first.</p>
      <div className="no-scrollbar -mx-4 mt-5 flex gap-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
        {channels.map((c) => (
          <Link key={c.id} href={`/@${c.handle}`} className="flex w-[84px] shrink-0 flex-col items-center gap-2 rounded-2xl p-2 text-center hover:bg-surface">
            <Avatar name={c.name} src={c.avatarUrl} size={60} /><span className="line-clamp-1 text-[12px] font-medium">{c.name}</span>
          </Link>
        ))}
      </div>
      <div className="mt-6">
        {data!.videos.length ? <VideoGrid first={data!} endpoint="/feed/following" /> : <p className="py-10 text-center text-[15px] text-muted">The Spaces you tune in to have not published videos yet.</p>}
      </div>
    </div>
  );
}
