import { BadgeCheck, EllipsisVertical, Play } from 'lucide-react';
import type { Video } from '../../types';

const views = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

const artwork: Record<string, [number, number]> = {
  vid_kigali_renaissance: [259, 287],
  vid_coffee_journey: [620, 287],
  vid_afrobeats_live: [982, 287],
  vid_volcanoes_gorillas: [259, 574],
  vid_fintech_boom: [620, 574],
  vid_rwandan_kitchen: [982, 574],
};

export function VideoCard({ video, onSelect, onSelectChannel }: {
  video: Video;
  onSelect: (video: Video) => void;
  onSelectChannel?: (channelId: string) => void;
}) {
  const position = artwork[video.id];
  const openChannel = video.channelId !== 'local-uploads' ? onSelectChannel : undefined;
  const duration = `${Math.floor(video.durationSeconds / 60)}:${String(Math.floor(video.durationSeconds % 60)).padStart(2, '0')}`;
  return (
    <article className="discovery-card">
      <button className="discovery-thumbnail" aria-label={`Watch ${video.title}`} onClick={() => onSelect(video)}>
        {position ? (
          <span className="discovery-art" aria-hidden="true" style={{
            backgroundPosition: `${position[0] / (1752 - 347) * 100}% ${position[1] / (897 - 175) * 100}%`,
          }} />
        ) : video.thumbnailUrl ? (
          <img src={video.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : <Play size={36} aria-hidden="true" />}
        {!position && video.durationSeconds > 0 && <span className="discovery-duration">{duration}</span>}
      </button>
      <div className="discovery-card-heading">
        <button className="discovery-title" onClick={() => onSelect(video)}>{video.title}</button>
        <details className="discovery-card-menu">
          <summary aria-label={`Options for ${video.title}`}><EllipsisVertical size={17} /></summary>
          <div>
            <button onClick={() => onSelect(video)}>Watch video</button>
            {openChannel && <button onClick={() => openChannel(video.channelId)}>Visit channel</button>}
          </div>
        </details>
      </div>
      <div className="discovery-meta">
        {openChannel ? <button onClick={() => openChannel(video.channelId)} aria-label={`Visit ${video.channelName}`}>
          <img src={video.channelAvatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
          <span>{video.channelName}</span>
        </button> : <span>{video.channelName}</span>}
        {video.channelVerified && <BadgeCheck size={14} className="discovery-verified" aria-label="Verified" />}
        <span>· {views.format(video.viewCount)} views · {video.createdAt}</span>
      </div>
    </article>
  );
}
