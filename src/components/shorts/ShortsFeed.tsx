import React, { useState, useRef, useEffect } from 'react';
import {
  ThumbsUp,
  MessageCircle,
  Share2,
  ChevronUp,
  ChevronDown,
  Volume2,
  VolumeX,
  Play,
  Pause,
  Disc3,
  X,
  Send,
  CheckCircle2,
} from 'lucide-react';
import { Video, User, Comment } from '../../types';

interface ShortsFeedProps {
  shorts: Video[];
  currentUser: User;
  onToggleLike: (videoId: string) => void;
  onToggleSubscribe: (channelId: string) => void;
  subscribedChannelIds: string[];
  onSelectChannel: (channelId: string) => void;
  onAddComment: (videoId: string, content: string) => void;
}

export const ShortsFeed: React.FC<ShortsFeedProps> = ({
  shorts,
  currentUser,
  onToggleLike,
  onToggleSubscribe,
  subscribedChannelIds,
  onSelectChannel,
  onAddComment,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [shortCommentText, setShortCommentText] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);

  const currentShort = shorts[currentIndex];

  const handleNext = () => {
    if (currentIndex < shorts.length - 1) {
      setCurrentIndex((prev) => prev + 1);
      setIsPlaying(true);
    }
  };

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex((prev) => prev - 1);
      setIsPlaying(true);
    }
  };

  // Keyboard navigation (Arrow keys up/down)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') handleNext();
      if (e.key === 'ArrowUp') handlePrev();
      if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, shorts.length]);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    videoRef.current.muted = newMuted;
  };

  const handleCommentSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!shortCommentText.trim() || !currentShort) return;
    onAddComment(currentShort.id, shortCommentText.trim());
    setShortCommentText('');
  };

  if (!currentShort) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-6rem)] text-slate-400">
        No short videos available.
      </div>
    );
  }

  const isSubscribed = subscribedChannelIds.includes(currentShort.channelId);

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-5rem)] py-4 px-2">
      <div className="relative flex items-center gap-4">
        {/* Main 9:16 Vertical Video Frame */}
        <div className="relative w-[340px] md:w-[380px] h-[640px] md:h-[680px] rounded-3xl overflow-hidden bg-black shadow-2xl border border-slate-800">
          <video
            ref={videoRef}
            key={currentShort.id}
            src={currentShort.videoUrl}
            poster={currentShort.thumbnailUrl}
            loop
            autoPlay
            playsInline
            muted={isMuted}
            onClick={togglePlay}
            className="w-full h-full object-cover cursor-pointer"
          />

          {/* Top Controls Overlay */}
          <div className="absolute top-4 inset-x-4 flex items-center justify-between text-white z-10 pointer-events-none">
            <div className="px-2.5 py-1 rounded-full bg-black/50 backdrop-blur-md text-xs font-mono font-semibold pointer-events-auto">
              Shorts · Free Me
            </div>
            <button
              onClick={toggleMute}
              className="p-2 rounded-full bg-black/50 backdrop-blur-md hover:bg-black/70 pointer-events-auto transition-colors"
            >
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
          </div>

          {/* Pause overlay icon */}
          {!isPlaying && (
            <div
              onClick={togglePlay}
              className="absolute inset-0 flex items-center justify-center bg-black/30 cursor-pointer z-10"
            >
              <div className="w-16 h-16 rounded-full bg-black/60 flex items-center justify-center text-white">
                <Play className="w-8 h-8 ml-1" />
              </div>
            </div>
          )}

          {/* Bottom Info Overlay */}
          <div className="absolute bottom-0 inset-x-0 p-5 bg-gradient-to-t from-black/90 via-black/40 to-transparent text-white space-y-3 z-10 pointer-events-auto">
            {/* Channel Bar */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => onSelectChannel(currentShort.channelId)}
                className="flex items-center gap-2.5 focus:outline-none group text-left"
              >
                <img
                  src={currentShort.channelAvatarUrl}
                  alt={currentShort.channelName}
                  referrerPolicy="no-referrer"
                  className="w-9 h-9 rounded-full object-cover border border-white/30 group-hover:scale-105 transition-transform"
                />
                <div className="leading-tight">
                  <span className="font-display font-semibold text-xs flex items-center gap-1 group-hover:text-amber-400">
                    {currentShort.channelName}
                    {currentShort.channelVerified && (
                      <CheckCircle2 className="w-3.5 h-3.5 text-amber-500" />
                    )}
                  </span>
                  <span className="text-[10px] text-white/70 font-mono">{currentShort.channelHandle}</span>
                </div>
              </button>

              <button
                onClick={() => onToggleSubscribe(currentShort.channelId)}
                className={`px-3 py-1 text-xs font-semibold rounded-full transition-colors ${
                  isSubscribed
                    ? 'bg-white/20 text-white hover:bg-white/30'
                    : 'bg-amber-600 hover:bg-amber-500 text-white shadow-sm'
                }`}
              >
                {isSubscribed ? 'Subscribed' : 'Subscribe'}
              </button>
            </div>

            {/* Video Caption Title */}
            <p className="text-xs text-white/95 leading-relaxed line-clamp-2 font-medium">
              {currentShort.title}
            </p>

            {/* Sound / Music info */}
            {currentShort.soundTitle && (
              <div className="flex items-center gap-2 text-[11px] text-white/80 font-mono">
                <Disc3 className="w-4 h-4 animate-spin text-amber-400" />
                <span className="truncate max-w-[200px]">{currentShort.soundTitle}</span>
              </div>
            )}
          </div>
        </div>

        {/* Floating Vertical Action Rail */}
        <div className="flex flex-col items-center gap-4 text-slate-700 dark:text-slate-300">
          {/* Like */}
          <button
            onClick={() => onToggleLike(currentShort.id)}
            className="flex flex-col items-center gap-1 group focus:outline-none"
          >
            <div
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-all ${
                currentShort.isLiked
                  ? 'bg-amber-600 text-white shadow-lg'
                  : 'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200'
              }`}
            >
              <ThumbsUp className="w-5 h-5" />
            </div>
            <span className="text-[11px] font-mono tabular-nums font-semibold">
              {(currentShort.likeCount / 1000).toFixed(1)}K
            </span>
          </button>

          {/* Comment */}
          <button
            onClick={() => setShowComments(!showComments)}
            className="flex flex-col items-center gap-1 group focus:outline-none"
          >
            <div className="w-11 h-11 rounded-full bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 transition-colors">
              <MessageCircle className="w-5 h-5" />
            </div>
            <span className="text-[11px] font-mono tabular-nums font-semibold">
              {currentShort.commentCount}
            </span>
          </button>

          {/* Share */}
          <button
            onClick={() => {
              navigator.clipboard?.writeText(window.location.href);
            }}
            title="Copy link"
            className="flex flex-col items-center gap-1 group focus:outline-none"
          >
            <div className="w-11 h-11 rounded-full bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 transition-colors">
              <Share2 className="w-5 h-5" />
            </div>
            <span className="text-[11px] font-semibold">Share</span>
          </button>

          {/* Next / Previous Arrow Nav */}
          <div className="pt-4 flex flex-col gap-2">
            <button
              onClick={handlePrev}
              disabled={currentIndex === 0}
              title="Previous short"
              className="w-10 h-10 rounded-full border border-slate-200 dark:border-slate-700 flex items-center justify-center disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <ChevronUp className="w-5 h-5" />
            </button>
            <button
              onClick={handleNext}
              disabled={currentIndex === shorts.length - 1}
              title="Next short"
              className="w-10 h-10 rounded-full border border-slate-200 dark:border-slate-700 flex items-center justify-center disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <ChevronDown className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* COMMENTS DRAWER / SIDE SHEET */}
        {showComments && (
          <div className="w-80 h-[640px] md:h-[680px] bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col justify-between p-4 z-30">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-700">
              <h4 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                Comments ({currentShort.commentCount})
              </h4>
              <button onClick={() => setShowComments(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto py-3 space-y-3 text-xs">
              <div className="flex items-start gap-2">
                <img
                  src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80"
                  alt="Viewer"
                  className="w-6 h-6 rounded-full object-cover shrink-0"
                />
                <div>
                  <span className="font-semibold text-slate-900 dark:text-slate-100">Fide Ndayisaba</span>
                  <p className="text-slate-600 dark:text-slate-300 mt-0.5">
                    This Rwandan creator quality is incredible! Keep publishing on Free Me 🔥
                  </p>
                </div>
              </div>
            </div>

            {/* Add Comment */}
            <form onSubmit={handleCommentSubmit} className="pt-2 border-t border-slate-100 dark:border-slate-700 flex gap-2">
              <input
                type="text"
                value={shortCommentText}
                onChange={(e) => setShortCommentText(e.target.value)}
                placeholder="Add a comment..."
                className="flex-1 px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <button
                type="submit"
                disabled={!shortCommentText.trim()}
                className="p-2 bg-amber-600 disabled:opacity-40 text-white rounded-lg"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};
