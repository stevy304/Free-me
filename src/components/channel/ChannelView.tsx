import React, { useState } from 'react';
import {
  CheckCircle2,
  Tv,
  Flame,
  Info,
  Calendar,
  Eye,
  Globe2,
} from 'lucide-react';
import { Channel, Video } from '../../types';
import { VideoCard } from '../video/VideoCard';

interface ChannelViewProps {
  channel: Channel;
  videos: Video[];
  isSubscribed: boolean;
  onToggleSubscribe: (channelId: string) => void;
  onSelectVideo: (video: Video) => void;
}

export const ChannelView: React.FC<ChannelViewProps> = ({
  channel,
  videos,
  isSubscribed,
  onToggleSubscribe,
  onSelectVideo,
}) => {
  const [activeTab, setActiveTab] = useState<'VIDEOS' | 'SHORTS' | 'ABOUT'>('VIDEOS');

  const channelVideos = videos.filter((v) => !v.isShort);
  const channelShorts = videos.filter((v) => v.isShort);

  return (
    <div className="workspace-page channel-page space-y-6">
      {/* Channel Banner */}
      <div className="relative w-full h-36 sm:h-48 lg:h-60 rounded-2xl overflow-hidden bg-slate-200 dark:bg-slate-800 border border-slate-200 dark:border-slate-800">
        <img
          src={channel.bannerUrl}
          alt={channel.name}
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
      </div>

      {/* Channel Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-4">
          <img
            src={channel.avatarUrl}
            alt={channel.name}
            referrerPolicy="no-referrer"
            className="w-16 h-16 md:w-20 md:h-20 rounded-full object-cover border-2 border-white dark:border-slate-900 shadow-md"
          />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="workspace-title">
                {channel.name}
              </h1>
              {channel.isVerified && <CheckCircle2 className="w-5 h-5 text-amber-500" />}
            </div>
            <p className="text-xs text-slate-500 font-mono mt-0.5">
              {channel.handle} · {(channel.subscriberCount / 1000).toFixed(1)}K subscribers · {channelVideos.length + channelShorts.length} videos
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 max-w-2xl line-clamp-2">
              {channel.description}
            </p>
          </div>
        </div>

        <div>
          <button
            onClick={() => onToggleSubscribe(channel.id)}
            className={`px-6 py-2.5 rounded-xl font-semibold text-xs transition-colors shadow-sm ${
              isSubscribed
                ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200'
                : 'bg-amber-600 hover:bg-amber-700 text-white'
            }`}
          >
            {isSubscribed ? 'Subscribed' : 'Subscribe'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="workspace-tabs">
        <button
          onClick={() => setActiveTab('VIDEOS')}
          className={`px-4 py-2.5 border-b-2 transition-colors flex items-center gap-1.5 ${
            activeTab === 'VIDEOS'
              ? 'border-amber-600 text-amber-600 dark:text-amber-400'
              : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <Tv className="w-4 h-4" />
          <span>Videos ({channelVideos.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('SHORTS')}
          className={`px-4 py-2.5 border-b-2 transition-colors flex items-center gap-1.5 ${
            activeTab === 'SHORTS'
              ? 'border-amber-600 text-amber-600 dark:text-amber-400'
              : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <Flame className="w-4 h-4 text-orange-500" />
          <span>Shorts ({channelShorts.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('ABOUT')}
          className={`px-4 py-2.5 border-b-2 transition-colors flex items-center gap-1.5 ${
            activeTab === 'ABOUT'
              ? 'border-amber-600 text-amber-600 dark:text-amber-400'
              : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <Info className="w-4 h-4" />
          <span>About</span>
        </button>
      </div>

      {/* Content View */}
      {activeTab === 'VIDEOS' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {channelVideos.map((vid) => (
            <VideoCard key={vid.id} video={vid} onSelect={onSelectVideo} />
          ))}
        </div>
      )}

      {activeTab === 'SHORTS' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {channelShorts.map((short) => (
            <div
              key={short.id}
              onClick={() => onSelectVideo(short)}
              className="group cursor-pointer rounded-2xl overflow-hidden bg-slate-900 aspect-[9/16] relative shadow-md"
            >
              <img
                src={short.thumbnailUrl}
                alt={short.title}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent flex flex-col justify-end p-3 text-white">
                <p className="text-xs font-semibold line-clamp-2 leading-snug">{short.title}</p>
                <div className="text-[10px] text-white/70 font-mono mt-1">
                  {(short.viewCount / 1000).toFixed(1)}K views
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'ABOUT' && (
        <div className="max-w-2xl bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 space-y-4 text-xs">
          <h3 className="font-display font-bold text-base text-slate-900 dark:text-white">
            Description
          </h3>
          <p className="text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-line text-sm">
            {channel.description}
          </p>

          <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-2 font-mono text-slate-500">
            <div className="flex items-center gap-2">
              <Globe2 className="w-4 h-4 text-slate-400" />
              <span>Location: Rwanda (Kigali Hub)</span>
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-slate-400" />
              <span>Joined Free Me: {channel.joinedDate}</span>
            </div>
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-slate-400" />
              <span>{channel.totalViews.toLocaleString()} channel views</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
