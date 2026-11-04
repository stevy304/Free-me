import { Compass, Play, Search } from 'lucide-react';
import { EmptyState } from '../components/layout/EmptyState';
import { VideoCard } from '../components/video/VideoCard';
import type { Video } from '../types';

const categories = [
  ['All Categories', 'All'],
  ['Music & Performance', 'Music'],
  ['Culinary & Coffee', 'Culture'],
  ['Tech & Innovation', 'Tech'],
  ['Travel', 'Travel'],
];

export function DiscoveryPage({
  title, videos, category, onCategory, onSelectVideo, onSelectChannel,
  compactHeading = false, featured = false, emptyMessage = 'No videos match this search.',
}: {
  title: string;
  compactHeading?: boolean;
  featured?: boolean;
  videos: Video[];
  category?: string;
  onCategory?: (category: string) => void;
  onSelectVideo: (video: Video) => void;
  onSelectChannel: (id: string) => void;
  emptyMessage?: string;
}) {
  const spotlight = featured && category === 'All Categories' ? videos[0] : undefined;
  const visibleVideos = spotlight ? videos.slice(1) : videos;
  return (
    <section className="discovery-feed">
      <h1 className={compactHeading ? 'sr-only' : undefined}>{title}</h1>
      {onCategory && (
        <div className="discovery-categories" aria-label="Video categories">
          {categories.map(([value, label]) => (
            <button type="button" key={value} aria-pressed={category === value}
              onClick={() => onCategory(value)}>{label}</button>
          ))}
        </div>
      )}
      {spotlight && (
        <section className="explore-spotlight" aria-label="Featured video">
          <div>
            <p className="workspace-eyebrow"><Compass size={15} aria-hidden="true" /> Featured on Free Me</p>
            <h2>{spotlight.title}</h2>
            <p className="explore-creator">{spotlight.channelName} · {spotlight.category}</p>
            <button className="workspace-primary" onClick={() => onSelectVideo(spotlight)}><Play size={16} aria-hidden="true" /> Watch now</button>
          </div>
          {spotlight.thumbnailUrl && <img src={spotlight.thumbnailUrl} alt="" />}
        </section>
      )}
      {visibleVideos.length ? (
        <div className={`discovery-grid ${onCategory ? '' : 'mt-6'}`}>
          {visibleVideos.map((video) => <VideoCard key={video.id} video={video}
            onSelect={onSelectVideo} onSelectChannel={onSelectChannel} />)}
        </div>
      ) : !spotlight && (
        <EmptyState icon={Search} title="Nothing to watch here yet" description={emptyMessage}>
          {onCategory && category !== 'All Categories' && <button className="workspace-primary" onClick={() => onCategory('All Categories')}>Clear category</button>}
        </EmptyState>
      )}
      <p className="mt-8 text-xs text-slate-500 dark:text-slate-400">Featured videos and engagement figures are sample content.</p>
    </section>
  );
}
