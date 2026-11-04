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
  compactHeading = false, emptyMessage = 'No videos match this search.',
}: {
  title: string;
  compactHeading?: boolean;
  videos: Video[];
  category?: string;
  onCategory?: (category: string) => void;
  onSelectVideo: (video: Video) => void;
  onSelectChannel: (id: string) => void;
  emptyMessage?: string;
}) {
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
      {videos.length ? (
        <div className={`discovery-grid ${onCategory ? '' : 'mt-6'}`}>
          {videos.map((video) => <VideoCard key={video.id} video={video}
            onSelect={onSelectVideo} onSelectChannel={onSelectChannel} />)}
        </div>
      ) : <p className="py-12 text-slate-500" role="status">{emptyMessage}</p>}
      <p className="mt-8 text-xs text-slate-500 dark:text-slate-400">Featured videos and engagement figures are sample content.</p>
    </section>
  );
}
