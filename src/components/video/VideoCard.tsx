import React from 'react';
import { CheckCircle2, DollarSign } from 'lucide-react';
import { Video } from '../../types';

interface VideoCardProps {
  video: Video;
  onSelect: (video: Video) => void;
  onSelectChannel?: (channelId: string) => void;
}

export const VideoCard: React.FC<VideoCardProps> = ({ video, onSelect, onSelectChannel }) => {
  const formatViews = (views: number): string => {
    if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
    if (views >= 1000) return `${(views / 1000).toFixed(1)}K`;
    return views.toString();
  };

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  return (
    <div className="group flex flex-col cursor-pointer transition-transform duration-200">
      {/* Thumbnail Container */}
      <div
        onClick={() => onSelect(video)}
        className="relative aspect-video w-full overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-800"
      >
        <img
          src={video.thumbnailUrl}
          alt={video.title}
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        />

        {/* Video Duration Badge */}
        <div className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] font-medium text-white shadow-sm">
          {formatDuration(video.durationSeconds)}
        </div>

        {/* Subtle Monetization Indicator */}
        {video.monetizationEnabled && (
          <div
            title="Monetized video (60% ad revenue share to creator)"
            className="absolute top-2 right-2 rounded bg-emerald-950/80 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-mono font-semibold text-emerald-300 border border-emerald-500/30 flex items-center gap-0.5"
          >
            <DollarSign className="w-3 h-3 text-emerald-400" />
            <span>Monetized</span>
          </div>
        )}
      </div>

      {/* Video Details & Unboxed Metadata */}
      <div className="mt-3 flex items-start gap-3">
        {/* Channel Avatar */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelectChannel?.(video.channelId);
          }}
          className="shrink-0 focus:outline-none"
        >
          <img
            src={video.channelAvatarUrl}
            alt={video.channelName}
            referrerPolicy="no-referrer"
            className="w-9 h-9 rounded-full object-cover border border-slate-200 dark:border-slate-700"
          />
        </button>

        {/* Text Details */}
        <div className="flex-1 min-w-0" onClick={() => onSelect(video)}>
          <h3 className="font-display font-semibold text-sm leading-snug text-slate-900 dark:text-slate-100 line-clamp-2 group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors">
            {video.title}
          </h3>

          {/* Channel Name */}
          <div className="mt-1 flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200">
            <span className="truncate">{video.channelName}</span>
            {video.channelVerified && (
              <CheckCircle2 className="w-3.5 h-3.5 text-amber-500 shrink-0" />
            )}
          </div>

          {/* Clean Unboxed Metadata with Typographic Dot Separators */}
          <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 font-normal">
            <span>{video.category}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{formatViews(video.viewCount)} views</span>
            <span aria-hidden="true">·</span>
            <span>{video.createdAt}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
