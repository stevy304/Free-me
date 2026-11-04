import React, { useState } from 'react';
import {
  ThumbsUp,
  ThumbsDown,
  Share2,
  Bookmark,
  Flag,
  DollarSign,
  CheckCircle2,
  Sparkles,
  Send,
  CornerDownRight,
  ShieldCheck,
  Check,
  Copy,
} from 'lucide-react';
import { Video, Channel, Comment, Campaign, User } from '../../types';
import { VideoPlayer } from './VideoPlayer';
import { formatCurrency } from '../../services/revenue';

interface WatchPageProps {
  video: Video;
  channel?: Channel;
  comments: Comment[];
  relatedVideos: Video[];
  activeAdCampaign?: Campaign;
  currentUser: User;
  currency: 'RWF' | 'USD';
  onSelectVideo: (video: Video) => void;
  onSelectChannel: (channelId: string) => void;
  onToggleLike: (videoId: string) => void;
  onToggleSubscribe: (channelId: string) => void;
  isSubscribed: boolean;
  onAddComment: (videoId: string, content: string, parentId?: string) => void;
  onAdImpressionCompleted: (campaign: Campaign) => void;
  onReportVideo: (videoId: string, reason: string) => void;
}

export const WatchPage: React.FC<WatchPageProps> = ({
  video,
  channel,
  comments,
  relatedVideos,
  activeAdCampaign,
  currentUser,
  currency,
  onSelectVideo,
  onSelectChannel,
  onToggleLike,
  onToggleSubscribe,
  isSubscribed,
  onAddComment,
  onAdImpressionCompleted,
  onReportVideo,
}) => {
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [newCommentText, setNewCommentText] = useState('');
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [showShareModal, setShowShareModal] = useState(false);
  const [copiedShareLink, setCopiedShareLink] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportReason, setReportReason] = useState('COPYRIGHT');
  const [reportSubmitted, setReportSubmitted] = useState(false);

  const handleCommentSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCommentText.trim()) return;
    onAddComment(video.id, newCommentText.trim());
    setNewCommentText('');
  };

  const handleReplySubmit = (parentId: string) => {
    if (!replyText.trim()) return;
    onAddComment(video.id, replyText.trim(), parentId);
    setReplyText('');
    setReplyingToId(null);
  };

  const handleCopyLink = () => {
    navigator.clipboard?.writeText(window.location.href);
    setCopiedShareLink(true);
    setTimeout(() => setCopiedShareLink(false), 2000);
  };

  const handleReportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onReportVideo(video.id, reportReason);
    setReportSubmitted(true);
    setTimeout(() => {
      setShowReportModal(false);
      setReportSubmitted(false);
    }, 1500);
  };

  // Estimated revenue calculation for this video
  const estimatedGrossRwf = Math.round((video.viewCount / 1000) * 6500);
  const estimatedCreatorEarningsRwf = Math.round(estimatedGrossRwf * 0.6);

  return (
    <div className="max-w-[1600px] mx-auto px-4 lg:px-8 py-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main Column: Player, Info, Monetization Breakdown & Comments */}
        <div className="lg:col-span-2 space-y-4">
          {/* Custom HLS & Pre-Roll Video Player */}
          <VideoPlayer
            video={video}
            activeAdCampaign={activeAdCampaign}
            onAdImpressionCompleted={onAdImpressionCompleted}
          />

          {/* Video Title */}
          <div>
            <h1 className="font-display font-bold text-xl md:text-2xl text-slate-900 dark:text-white leading-tight">
              {video.title}
            </h1>

            {/* Unboxed Metadata Line */}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="font-medium text-slate-700 dark:text-slate-300">{video.category}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{video.viewCount.toLocaleString()} views</span>
              <span aria-hidden="true">·</span>
              <span>Published {video.createdAt}</span>
              {video.monetizationEnabled && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                    <DollarSign className="w-3 h-3" />
                    Verified Monetized Creator Pool
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Channel Bar & Action Buttons */}
          <div className="flex flex-wrap items-center justify-between gap-4 py-3 border-y border-slate-200 dark:border-slate-800">
            {/* Channel Info */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => onSelectChannel(video.channelId)}
                className="shrink-0 focus:outline-none"
              >
                <img
                  src={video.channelAvatarUrl}
                  alt={video.channelName}
                  referrerPolicy="no-referrer"
                  className="w-11 h-11 rounded-full object-cover border border-slate-200 dark:border-slate-700"
                />
              </button>
              <div>
                <button
                  onClick={() => onSelectChannel(video.channelId)}
                  className="flex items-center gap-1 font-display font-semibold text-sm text-slate-900 dark:text-slate-100 hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
                >
                  <span>{video.channelName}</span>
                  {video.channelVerified && (
                    <CheckCircle2 className="w-4 h-4 text-amber-500 shrink-0" />
                  )}
                </button>
                <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {channel ? `${(channel.subscriberCount / 1000).toFixed(1)}K subscribers` : 'Verified Creator'}
                </div>
              </div>

              {/* Subscribe Button */}
              <button
                onClick={() => onToggleSubscribe(video.channelId)}
                className={`ml-3 px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 shadow-sm ${
                  isSubscribed
                    ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                    : 'bg-amber-600 hover:bg-amber-700 text-white'
                }`}
              >
                {isSubscribed ? 'Subscribed' : 'Subscribe'}
              </button>
            </div>

            {/* Interaction Buttons */}
            <div className="flex items-center gap-2">
              {/* Like / Dislike Group */}
              <div className="flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-0.5">
                <button
                  onClick={() => onToggleLike(video.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    video.isLiked
                      ? 'text-amber-600 dark:text-amber-400 font-bold bg-white dark:bg-slate-700 shadow-sm'
                      : 'text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <ThumbsUp className="w-4 h-4" />
                  <span className="tabular-nums">{video.likeCount.toLocaleString()}</span>
                </button>
                <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />
                <button
                  className="px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white rounded-md transition-colors"
                >
                  <ThumbsDown className="w-4 h-4" />
                </button>
              </div>

              {/* Share */}
              <button
                onClick={() => setShowShareModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 transition-colors"
              >
                <Share2 className="w-3.5 h-3.5" />
                <span>Share</span>
              </button>

              {/* Report */}
              <button
                onClick={() => setShowReportModal(true)}
                title="Report video"
                className="p-2 text-xs rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 transition-colors"
              >
                <Flag className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* TRANSPARENT CREATOR MONETIZATION AUDIT CARD */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 text-xs">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-emerald-500" />
                <span className="font-display font-semibold text-slate-900 dark:text-slate-100">
                  Creator Economy Transparency Audit
                </span>
              </div>
              <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400 font-bold bg-emerald-50 dark:bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-200 dark:border-emerald-800/40">
                Audited 60/30/10 Policy
              </span>
            </div>
            <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
              On Free Me, <span className="font-semibold text-slate-800 dark:text-slate-200">60%</span> of all local advertising spent on this video directly funds{' '}
              <span className="font-semibold text-slate-800 dark:text-slate-200">{video.channelName}</span>.
              Estimated gross ad pool: <span className="font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-200">{formatCurrency(estimatedGrossRwf, currency)}</span>,
              yielding an estimated <span className="font-mono tabular-nums font-bold text-emerald-600 dark:text-emerald-400">{formatCurrency(estimatedCreatorEarningsRwf, currency)}</span> directly to the creator’s Mobile Money / Bank balance.
            </p>
          </div>

          {/* Description Section */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 text-sm">
            <p className={`text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-line ${descriptionExpanded ? '' : 'line-clamp-3'}`}>
              {video.description}
            </p>

            <div className="mt-3 flex flex-wrap gap-2 text-xs font-mono text-amber-600 dark:text-amber-400">
              {video.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>

            <button
              onClick={() => setDescriptionExpanded(!descriptionExpanded)}
              className="mt-3 text-xs font-semibold text-slate-900 dark:text-slate-100 hover:text-amber-600 transition-colors"
            >
              {descriptionExpanded ? 'Show less' : '...more'}
            </button>
          </div>

          {/* Comments Section */}
          <div className="pt-4 space-y-4">
            <div className="flex items-center gap-3">
              <h3 className="font-display font-bold text-base text-slate-900 dark:text-slate-100">
                {comments.length} Comments
              </h3>
            </div>

            {/* New Comment Box */}
            <form onSubmit={handleCommentSubmit} className="flex gap-3">
              <img
                src={currentUser.avatarUrl}
                alt={currentUser.displayName}
                referrerPolicy="no-referrer"
                className="w-9 h-9 rounded-full object-cover border border-slate-200 dark:border-slate-700 shrink-0"
              />
              <div className="flex-1 space-y-2">
                <input
                  type="text"
                  value={newCommentText}
                  onChange={(e) => setNewCommentText(e.target.value)}
                  placeholder={`Comment as ${currentUser.displayName}...`}
                  className="w-full px-3.5 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500/50 text-slate-900 dark:text-slate-100"
                />
                {newCommentText.trim() && (
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setNewCommentText('')}
                      className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="px-4 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg shadow-sm"
                    >
                      Comment
                    </button>
                  </div>
                )}
              </div>
            </form>

            {/* Existing Comments List */}
            <div className="space-y-4 pt-2">
              {comments.map((comm) => (
                <div key={comm.id} className="space-y-2 text-sm">
                  <div className="flex items-start gap-3">
                    <img
                      src={comm.userAvatar}
                      alt={comm.userName}
                      referrerPolicy="no-referrer"
                      className="w-8 h-8 rounded-full object-cover border border-slate-200 dark:border-slate-700 shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-xs text-slate-900 dark:text-slate-100">
                          {comm.userName}
                        </span>
                        <span className="text-[11px] text-slate-400">{comm.createdAt}</span>
                      </div>
                      <p className="mt-1 text-slate-700 dark:text-slate-300 text-xs md:text-sm leading-relaxed">
                        {comm.content}
                      </p>

                      <div className="mt-2 flex items-center gap-4 text-xs text-slate-500">
                        <button className="flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-300">
                          <ThumbsUp className="w-3.5 h-3.5" />
                          <span className="tabular-nums">{comm.likeCount}</span>
                        </button>
                        <button
                          onClick={() => setReplyingToId(replyingToId === comm.id ? null : comm.id)}
                          className="font-medium hover:text-slate-700 dark:hover:text-slate-300"
                        >
                          Reply
                        </button>
                      </div>

                      {/* Reply Input Box */}
                      {replyingToId === comm.id && (
                        <div className="mt-3 flex gap-2">
                          <input
                            type="text"
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            placeholder="Write a reply..."
                            className="flex-1 px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-amber-500"
                          />
                          <button
                            type="button"
                            onClick={() => handleReplySubmit(comm.id)}
                            className="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-semibold"
                          >
                            Reply
                          </button>
                        </div>
                      )}

                      {/* Nested Replies */}
                      {comm.replies && comm.replies.length > 0 && (
                        <div className="mt-3 space-y-2 pl-4 border-l-2 border-slate-200 dark:border-slate-700">
                          {comm.replies.map((reply) => (
                            <div key={reply.id} className="flex items-start gap-2.5">
                              <img
                                src={reply.userAvatar}
                                alt={reply.userName}
                                referrerPolicy="no-referrer"
                                className="w-6 h-6 rounded-full object-cover shrink-0"
                              />
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span className="font-semibold text-xs text-slate-900 dark:text-slate-100">
                                    {reply.userName}
                                  </span>
                                  <span className="text-[10px] text-slate-400">{reply.createdAt}</span>
                                </div>
                                <p className="mt-0.5 text-xs text-slate-700 dark:text-slate-300">
                                  {reply.content}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Sidebar: Related Videos Column */}
        <div className="space-y-4">
          <h3 className="font-display font-semibold text-sm text-slate-900 dark:text-slate-100">
            Up Next · African Stories
          </h3>

          <div className="space-y-3">
            {relatedVideos.map((rel) => (
              <div
                key={rel.id}
                onClick={() => onSelectVideo(rel)}
                className="group flex gap-3 cursor-pointer p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors"
              >
                <div className="relative w-40 aspect-video rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-800 shrink-0 border border-slate-200/80 dark:border-slate-800">
                  <img
                    src={rel.thumbnailUrl}
                    alt={rel.title}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                  />
                  <div className="absolute bottom-1 right-1 rounded bg-black/80 px-1 py-0.2 font-mono text-[10px] text-white">
                    {Math.floor(rel.durationSeconds / 60)}:{(rel.durationSeconds % 60).toString().padStart(2, '0')}
                  </div>
                </div>

                <div className="flex-1 min-w-0">
                  <h4 className="font-display font-semibold text-xs leading-snug text-slate-900 dark:text-slate-100 line-clamp-2 group-hover:text-amber-600 transition-colors">
                    {rel.title}
                  </h4>
                  <p className="mt-1 text-[11px] text-slate-500 truncate">{rel.channelName}</p>
                  <div className="mt-0.5 text-[11px] text-slate-400 flex items-center gap-1 font-mono">
                    <span>{(rel.viewCount / 1000).toFixed(1)}K views</span>
                    <span>·</span>
                    <span>{rel.createdAt}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* SHARE MODAL */}
      {showShareModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-2xl space-y-4">
            <h3 className="font-display font-bold text-lg text-slate-900 dark:text-slate-100">
              Share Video
            </h3>
            <p className="text-xs text-slate-500">
              Share this African creator’s work with friends, WhatsApp groups, or social channels.
            </p>
            <div className="flex items-center gap-2 p-2 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700">
              <input
                type="text"
                readOnly
                value={window.location.href}
                className="flex-1 bg-transparent text-xs text-slate-700 dark:text-slate-300 font-mono focus:outline-none"
              />
              <button
                onClick={handleCopyLink}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold bg-amber-600 text-white rounded-md hover:bg-amber-700 transition-colors"
              >
                {copiedShareLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedShareLink ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <div className="flex justify-end pt-2">
              <button
                onClick={() => setShowShareModal(false)}
                className="px-4 py-1.5 text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* REPORT MODAL */}
      {showReportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-2xl space-y-4">
            <h3 className="font-display font-bold text-lg text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Flag className="w-5 h-5 text-rose-500" />
              <span>Report Video</span>
            </h3>

            {reportSubmitted ? (
              <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 text-xs flex items-center gap-2">
                <Check className="w-4 h-4" />
                <span>Thank you. Report filed with Free Me Governance Desk.</span>
              </div>
            ) : (
              <form onSubmit={handleReportSubmit} className="space-y-3">
                <p className="text-xs text-slate-500">
                  Select the issue you would like our moderation team in Kigali to review:
                </p>
                <div className="space-y-2 text-xs">
                  {[
                    { id: 'COPYRIGHT', label: 'Copyright or Intellectual Property Infringement' },
                    { id: 'INAPPROPRIATE', label: 'Inappropriate or Harmful Content' },
                    { id: 'MISINFORMATION', label: 'Misleading or Deceptive Information' },
                    { id: 'SPAM', label: 'Spam or Commercial Fraud' },
                  ].map((r) => (
                    <label key={r.id} className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700/50">
                      <input
                        type="radio"
                        name="reason"
                        value={r.id}
                        checked={reportReason === r.id}
                        onChange={(e) => setReportReason(e.target.value)}
                        className="accent-amber-600"
                      />
                      <span className="text-slate-700 dark:text-slate-200">{r.label}</span>
                    </label>
                  ))}
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-700">
                  <button
                    type="button"
                    onClick={() => setShowReportModal(false)}
                    className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg shadow-sm"
                  >
                    Submit Report
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
