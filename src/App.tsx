/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  INITIAL_USERS,
  INITIAL_CHANNELS,
  INITIAL_VIDEOS,
  INITIAL_CAMPAIGNS,
  INITIAL_CREATOR_BALANCES,
  INITIAL_LEDGER,
  INITIAL_PAYOUTS,
  INITIAL_COMMENTS,
  INITIAL_AUDIT_LOGS,
  INITIAL_REPORTS,
} from './services/store';
import {
  User,
  Channel,
  Video,
  Campaign,
  CreatorBalance,
  RevenueLedgerEntry,
  PayoutRequest,
  Comment,
  AuditLogItem,
  ModerationReport,
  PlatformSettings,
  PayoutMethod,
} from './types';
import { DEFAULT_PLATFORM_SETTINGS, calculateRevenueSplit } from './services/revenue';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';
import { VideoCard } from './components/video/VideoCard';
import { WatchPage } from './components/video/WatchPage';
import { ShortsFeed } from './components/shorts/ShortsFeed';
import { CreatorStudio } from './components/studio/CreatorStudio';
import { VideoUploadModal } from './components/studio/VideoUploadModal';
import { AdvertiserStudio } from './components/advertiser/AdvertiserStudio';
import { AdminDashboard } from './components/admin/AdminDashboard';
import { ChannelView } from './components/channel/ChannelView';
import { runRevenueTests } from './tests/revenue.test';

import {
  Sparkles,
  Play,
  Flame,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  ExternalLink,
  DollarSign,
  TrendingUp,
} from 'lucide-react';

export default function App() {
  // Theme & Currency
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
  });
  const [currency, setCurrency] = useState<'RWF' | 'USD'>('RWF');

  // Active User / Role Persona
  const [users, setUsers] = useState<User[]>(INITIAL_USERS);
  const [currentUser, setCurrentUser] = useState<User>(INITIAL_USERS[0]); // Viewer default

  // Domain State
  const [channels, setChannels] = useState<Channel[]>(INITIAL_CHANNELS);
  const [videos, setVideos] = useState<Video[]>(INITIAL_VIDEOS);
  const [campaigns, setCampaigns] = useState<Campaign[]>(INITIAL_CAMPAIGNS);
  const [balances, setBalances] = useState<Record<string, CreatorBalance>>(INITIAL_CREATOR_BALANCES);
  const [ledger, setLedger] = useState<RevenueLedgerEntry[]>(INITIAL_LEDGER);
  const [payouts, setPayouts] = useState<PayoutRequest[]>(INITIAL_PAYOUTS);
  const [comments, setComments] = useState<Comment[]>(INITIAL_COMMENTS);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>(INITIAL_AUDIT_LOGS);
  const [reports, setReports] = useState<ModerationReport[]>(INITIAL_REPORTS);
  const [settings, setSettings] = useState<PlatformSettings>(DEFAULT_PLATFORM_SETTINGS);

  // Subscriptions & Watch History
  const [subscribedChannelIds, setSubscribedChannelIds] = useState<string[]>(['chan_clarisse']);

  // Navigation & View
  const [currentView, setCurrentView] = useState<string>('home');
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('All Categories');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Modals
  const [showUploadModal, setShowUploadModal] = useState<boolean>(false);

  // Run automated unit tests silently on load
  const [testResults, setTestResults] = useState(() => runRevenueTests());

  // Apply dark mode class to <html>
  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  const toggleDarkMode = () => setDarkMode((prev) => !prev);
  const toggleCurrency = () => setCurrency((prev) => (prev === 'RWF' ? 'USD' : 'RWF'));

  // Navigation router helper
  const handleNavigate = (view: string, param?: string) => {
    if (view === 'watch' && param) {
      const v = videos.find((item) => item.id === param);
      if (v) {
        setSelectedVideo(v);
        setCurrentView('watch');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
    }
    if (view === 'channel' && param) {
      setSelectedChannelId(param);
      setCurrentView('channel');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setCurrentView(view);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSelectVideo = (video: Video) => {
    setSelectedVideo(video);
    setCurrentView('watch');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSelectChannel = (channelId: string) => {
    setSelectedChannelId(channelId);
    setCurrentView('channel');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Video Actions
  const handleToggleLike = (videoId: string) => {
    setVideos((prev) =>
      prev.map((v) => {
        if (v.id === videoId) {
          const isLiked = !v.isLiked;
          return {
            ...v,
            isLiked,
            likeCount: isLiked ? v.likeCount + 1 : Math.max(0, v.likeCount - 1),
          };
        }
        return v;
      })
    );

    if (selectedVideo?.id === videoId) {
      setSelectedVideo((prev) =>
        prev
          ? {
              ...prev,
              isLiked: !prev.isLiked,
              likeCount: !prev.isLiked ? prev.likeCount + 1 : Math.max(0, prev.likeCount - 1),
            }
          : null
      );
    }
  };

  const handleToggleSubscribe = (channelId: string) => {
    setSubscribedChannelIds((prev) => {
      const isSub = prev.includes(channelId);
      const next = isSub ? prev.filter((id) => id !== channelId) : [...prev, channelId];

      setChannels((cList) =>
        cList.map((ch) =>
          ch.id === channelId
            ? { ...ch, subscriberCount: isSub ? ch.subscriberCount - 1 : ch.subscriberCount + 1 }
            : ch
        )
      );
      return next;
    });
  };

  const handleAddComment = (videoId: string, content: string, parentId?: string) => {
    const newComment: Comment = {
      id: `comm_${Date.now()}`,
      videoId,
      userId: currentUser.id,
      userName: currentUser.displayName,
      userAvatar: currentUser.avatarUrl,
      content,
      likeCount: 0,
      createdAt: 'Just now',
    };

    if (parentId) {
      setComments((prev) =>
        prev.map((c) =>
          c.id === parentId
            ? { ...c, replies: [...(c.replies || []), newComment] }
            : c
        )
      );
    } else {
      setComments((prev) => [newComment, ...prev]);
    }

    setVideos((prev) =>
      prev.map((v) => (v.id === videoId ? { ...v, commentCount: v.commentCount + 1 } : v))
    );
  };

  // Ad Impression & 60% Creator Revenue Distribution
  const handleAdImpressionCompleted = (campaign: Campaign) => {
    if (!selectedVideo) return;

    // Calculate split on single impression cost: (CPM / 1000)
    const costRwf = Math.round(campaign.cpmRateRwf / 1000);
    const split = calculateRevenueSplit(costRwf, settings);

    // Update campaign metrics
    setCampaigns((prev) =>
      prev.map((c) =>
        c.id === campaign.id
          ? {
              ...c,
              spentAmountRwf: c.spentAmountRwf + costRwf,
              impressionsCount: c.impressionsCount + 1,
            }
          : c
      )
    );

    // Credit creator balance
    const chId = selectedVideo.channelId;
    setBalances((prev) => {
      const currentBal = prev[chId] || {
        channelId: chId,
        pendingBalanceRwf: 0,
        confirmedBalanceRwf: 0,
        lifetimeEarningsRwf: 0,
        withdrawnRwf: 0,
      };

      return {
        ...prev,
        [chId]: {
          ...currentBal,
          pendingBalanceRwf: currentBal.pendingBalanceRwf + split.creatorShareRwf,
          lifetimeEarningsRwf: currentBal.lifetimeEarningsRwf + split.creatorShareRwf,
        },
      };
    });

    // Add entry to audited revenue ledger
    const newEntry: RevenueLedgerEntry = {
      id: `ledg_${Date.now()}`,
      channelId: chId,
      channelName: selectedVideo.channelName,
      sourceType: 'PRE_ROLL_AD_SHARE',
      grossAmountRwf: costRwf,
      creatorShareRwf: split.creatorShareRwf,
      platformShareRwf: split.platformShareRwf,
      reinvestShareRwf: split.reinvestShareRwf,
      balanceAfterRwf: (balances[chId]?.confirmedBalanceRwf || 0) + split.creatorShareRwf,
      description: `Verified pre-roll impression from ${campaign.businessName} on "${selectedVideo.title}"`,
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setLedger((prev) => [newEntry, ...prev]);
  };

  // Upload Video Flow
  const handleUploadComplete = (newVidData: Partial<Video>) => {
    const defaultChannel = channels[0];
    const newVideo: Video = {
      id: `vid_${Date.now()}`,
      channelId: currentUser.channelId || defaultChannel.id,
      channelName: currentUser.channelId ? currentUser.displayName : defaultChannel.name,
      channelHandle: currentUser.channelId ? `@${currentUser.displayName.toLowerCase().replace(/\s+/g, '_')}` : defaultChannel.handle,
      channelAvatarUrl: currentUser.avatarUrl,
      channelVerified: true,
      title: newVidData.title || 'Untitled African Story',
      description: newVidData.description || '',
      category: newVidData.category || 'Kigali Life',
      tags: ['FreeMe', 'AfricanCreators', 'Rwanda'],
      status: 'READY',
      visibility: 'PUBLIC',
      durationSeconds: newVidData.durationSeconds || 320,
      thumbnailUrl: newVidData.thumbnailUrl || '/src/assets/images/hero_african_creator_1793734955093.jpg',
      videoUrl: newVidData.videoUrl || 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      isShort: Boolean(newVidData.isShort),
      monetizationEnabled: Boolean(newVidData.monetizationEnabled),
      viewCount: 1,
      likeCount: 0,
      commentCount: 0,
      createdAt: 'Just now',
      renditions: newVidData.renditions || [],
    };

    setVideos((prev) => [newVideo, ...prev]);

    // Audit log
    setAuditLogs((prev) => [
      {
        id: `audit_${Date.now()}`,
        timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
        adminName: currentUser.displayName,
        action: 'VIDEO_TRANSCODED',
        entityType: 'Video',
        entityId: newVideo.id,
        details: `HLS ladder generated on Media Node 4 for "${newVideo.title}"`,
      },
      ...prev,
    ]);
  };

  // Creator Payout Request
  const handleRequestPayout = (
    amountRwf: number,
    method: PayoutMethod,
    accountIdentifier: string,
    accountHolderName: string
  ) => {
    const chId = currentUser.channelId || 'chan_clarisse';
    const newPayout: PayoutRequest = {
      id: `pay_${Date.now()}`,
      channelId: chId,
      channelName: currentUser.displayName,
      amountRwf,
      currency: 'RWF',
      method,
      accountIdentifier,
      accountHolderName,
      status: 'REQUESTED',
      requestedAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
    };

    setPayouts((prev) => [newPayout, ...prev]);

    // Deduct from confirmed balance immediately to prevent double spending
    setBalances((prev) => ({
      ...prev,
      [chId]: {
        ...prev[chId],
        confirmedBalanceRwf: Math.max(0, prev[chId].confirmedBalanceRwf - amountRwf),
        withdrawnRwf: prev[chId].withdrawnRwf + amountRwf,
      },
    }));
  };

  // Advertiser Campaign Creation
  const handleCreateCampaign = (newCampData: Partial<Campaign>) => {
    const newCampaign: Campaign = {
      id: `camp_${Date.now()}`,
      advertiserId: currentUser.advertiserId || 'adv_local',
      businessName: newCampData.businessName || currentUser.displayName,
      name: newCampData.name || 'New Campaign',
      adFormat: newCampData.adFormat || 'PRE_ROLL',
      status: 'PENDING_REVIEW',
      budgetAmountRwf: newCampData.budgetAmountRwf || 500000,
      spentAmountRwf: 0,
      targetCountry: newCampData.targetCountry || 'RW',
      targetCategory: newCampData.targetCategory || 'All Categories',
      cpmRateRwf: newCampData.cpmRateRwf || 6500,
      adCreativeUrl: newCampData.adCreativeUrl || 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      destinationUrl: newCampData.destinationUrl || 'https://freeme.rw',
      headline: newCampData.headline || '',
      callToAction: newCampData.callToAction || 'Learn More',
      impressionsCount: 0,
      clicksCount: 0,
      startDate: new Date().toISOString().split('T')[0],
      endDate: '2026-06-30',
    };

    setCampaigns((prev) => [newCampaign, ...prev]);
  };

  // Admin Actions
  const handleApproveCampaign = (campaignId: string) => {
    setCampaigns((prev) =>
      prev.map((c) => (c.id === campaignId ? { ...c, status: 'ACTIVE' } : c))
    );
    setAuditLogs((prev) => [
      {
        id: `audit_${Date.now()}`,
        timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
        adminName: currentUser.displayName,
        action: 'CAMPAIGN_APPROVED',
        entityType: 'Campaign',
        entityId: campaignId,
        details: 'Approved local advertisement for active video pre-roll delivery.',
      },
      ...prev,
    ]);
  };

  const handleRejectCampaign = (campaignId: string) => {
    setCampaigns((prev) =>
      prev.map((c) => (c.id === campaignId ? { ...c, status: 'REJECTED' } : c))
    );
  };

  const handleApprovePayout = (payoutId: string) => {
    setPayouts((prev) =>
      prev.map((p) =>
        p.id === payoutId
          ? { ...p, status: 'PAID', processedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
          : p
      )
    );
    setAuditLogs((prev) => [
      {
        id: `audit_${Date.now()}`,
        timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
        adminName: currentUser.displayName,
        action: 'PAYOUT_DISBURSED',
        entityType: 'Payout',
        entityId: payoutId,
        details: 'Disbursed payout via MTN MoMo / Bank of Kigali integration.',
      },
      ...prev,
    ]);
  };

  const handleRejectPayout = (payoutId: string) => {
    setPayouts((prev) =>
      prev.map((p) => (p.id === payoutId ? { ...p, status: 'REJECTED' } : p))
    );
  };

  const handleResolveReport = (reportId: string, action: 'RESOLVED' | 'DISMISSED') => {
    setReports((prev) =>
      prev.map((r) => (r.id === reportId ? { ...r, status: action } : r))
    );
  };

  const handleReportVideo = (videoId: string, reason: string) => {
    const v = videos.find((item) => item.id === videoId);
    setReports((prev) => [
      {
        id: `rep_${Date.now()}`,
        videoId,
        videoTitle: v?.title || 'Reported Video',
        reporterName: currentUser.displayName,
        reason: reason as any,
        details: 'User community report submitted from watch page.',
        status: 'PENDING',
        createdAt: 'Just now',
      },
      ...prev,
    ]);
  };

  // Category & Search Filtering
  const filteredVideos = videos.filter((v) => {
    if (v.isShort && currentView === 'home') return false; // Shorts have dedicated reel & page
    if (selectedCategory !== 'All Categories' && v.category !== selectedCategory) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = v.title.toLowerCase().includes(q);
      const matchChannel = v.channelName.toLowerCase().includes(q);
      const matchCat = v.category.toLowerCase().includes(q);
      const matchTags = v.tags.some((t) => t.toLowerCase().includes(q));
      return matchTitle || matchChannel || matchCat || matchTags;
    }
    return true;
  });

  const shortsList = videos.filter((v) => v.isShort);
  const activeAdCampaign = campaigns.find((c) => c.status === 'ACTIVE' && c.adFormat === 'PRE_ROLL');

  // Channel lookup for watch page or channel page
  const currentChannel = channels.find((c) => c.id === selectedChannelId) || channels[0];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col font-sans transition-colors">
      {/* Top Bar adhering to Top Bar Contract */}
      <Header
        currentUser={currentUser}
        users={users}
        onSelectUser={(u) => {
          setCurrentUser(u);
          if (u.role === 'CREATOR') setCurrentView('studio');
          else if (u.role === 'ADVERTISER') setCurrentView('advertiser');
          else if (u.role === 'ADMIN') setCurrentView('admin');
        }}
        currency={currency}
        onToggleCurrency={toggleCurrency}
        darkMode={darkMode}
        onToggleDarkMode={toggleDarkMode}
        onOpenUpload={() => setShowUploadModal(true)}
        onNavigate={handleNavigate}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSearchSubmit={(e) => {
          e.preventDefault();
          setCurrentView('home');
        }}
      />

      <div className="flex-1 flex">
        {/* Desktop Sidebar Navigation */}
        <Sidebar
          currentView={currentView}
          onNavigate={handleNavigate}
          selectedCategory={selectedCategory}
          onSelectCategory={(cat) => {
            setSelectedCategory(cat);
            setCurrentView('home');
          }}
          currentUser={currentUser}
        />

        {/* Main Content Area */}
        <main className="flex-1 min-w-0 pb-16">
          {/* VIEW: HOME FEED */}
          {currentView === 'home' && (
            <div className="max-w-[1520px] mx-auto px-4 md:px-8 py-6 space-y-8">
              {/* Category Filter Bar (Functional segmented buttons as allowed by Section 1.A) */}
              <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
                {[
                  'All Categories',
                  'Kigali Life',
                  'Tech & Innovation',
                  'Wildlife & Safari',
                  'Music & Performance',
                  'Culinary & Coffee',
                ].map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-3.5 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
                      selectedCategory === cat
                        ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 shadow-sm'
                        : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700/80 hover:bg-slate-100 dark:hover:bg-slate-700'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              {/* Hero Spotlight (When on All Categories and no search) */}
              {selectedCategory === 'All Categories' && !searchQuery && (
                <div className="relative rounded-3xl overflow-hidden bg-slate-900 text-white border border-slate-800 shadow-xl">
                  <div className="grid grid-cols-1 lg:grid-cols-12 items-stretch min-h-[380px]">
                    <div className="lg:col-span-7 p-6 sm:p-10 flex flex-col justify-between space-y-6">
                      <div className="space-y-3">
                        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-mono">
                          <Sparkles className="w-3.5 h-3.5" />
                          <span>African Creator Renaissance · Rwanda Hub</span>
                        </div>
                        <h2 className="font-display font-extrabold text-2xl sm:text-4xl leading-tight tracking-tight text-white max-w-xl text-balance">
                          Your content. Your freedom. Your opportunity.
                        </h2>
                        <p className="text-sm text-slate-300 leading-relaxed max-w-lg">
                          Free Me empowers African digital storytellers with a guaranteed{' '}
                          <span className="text-amber-400 font-semibold">60% creator share</span> of local advertising, instant Mobile Money payouts, and high-performance HLS video streaming.
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-3 pt-2">
                        <button
                          onClick={() => handleSelectVideo(videos[0])}
                          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs transition-colors shadow-lg"
                        >
                          <Play className="w-4 h-4 fill-current" />
                          <span>Watch Featured Video</span>
                        </button>
                        <button
                          onClick={() => handleNavigate('studio')}
                          className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-medium border border-white/20 transition-colors"
                        >
                          <span>Explore Creator Studio</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="lg:col-span-5 relative min-h-[260px] lg:min-h-full">
                      <img
                        src="/src/assets/images/hero_african_creator_1793734955093.jpg"
                        alt="Clarisse Uwase in studio"
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover lg:absolute lg:inset-0"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-transparent to-transparent lg:bg-gradient-to-r lg:from-slate-900 lg:to-transparent" />
                      <div className="absolute bottom-4 left-4 right-4 p-3 rounded-xl bg-black/60 backdrop-blur-md border border-white/10 text-xs flex items-center justify-between">
                        <div>
                          <div className="font-semibold text-white">Clarisse Media — Kigali Stories</div>
                          <div className="text-[11px] text-amber-400 font-mono">Top Rwandan Creator Partner</div>
                        </div>
                        <CheckCircle2 className="w-4 h-4 text-amber-500" />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Videos Grid */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-display font-bold text-lg text-slate-900 dark:text-white">
                    {searchQuery ? `Search Results for "${searchQuery}"` : selectedCategory}
                  </h3>
                  <span className="text-xs font-mono text-slate-400">
                    {filteredVideos.length} videos available
                  </span>
                </div>

                {filteredVideos.length === 0 ? (
                  <div className="text-center py-12 text-slate-400 text-sm">
                    No videos found matching your filter. Try another category or search term.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {filteredVideos.map((vid) => (
                      <VideoCard
                        key={vid.id}
                        video={vid}
                        onSelect={handleSelectVideo}
                        onSelectChannel={handleSelectChannel}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Shorts Spotlight Reel */}
              {shortsList.length > 0 && !searchQuery && (
                <div className="pt-6 border-t border-slate-200 dark:border-slate-800 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Flame className="w-5 h-5 text-orange-500" />
                      <h3 className="font-display font-bold text-lg text-slate-900 dark:text-white">
                        Free Me Shorts
                      </h3>
                    </div>
                    <button
                      onClick={() => handleNavigate('shorts')}
                      className="text-xs font-semibold text-amber-600 dark:text-amber-400 hover:underline flex items-center gap-1"
                    >
                      <span>View All Shorts</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                    {shortsList.slice(0, 6).map((short) => (
                      <div
                        key={short.id}
                        onClick={() => handleNavigate('shorts')}
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
                </div>
              )}

              {/* Clean Local Advertiser Showcase Banner (Anti-Slop compliant, clear disclosure) */}
              <div className="pt-4">
                <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-950/40 text-amber-600 flex items-center justify-center font-bold">
                      BK
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 font-bold">
                          Sponsored by Local Partner
                        </span>
                        <span className="text-slate-300 dark:text-slate-700">·</span>
                        <span className="text-xs font-bold text-slate-900 dark:text-white">
                          Bank of Kigali MoMo Integration
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-400">
                        Zero transaction fees for Rwandan digital merchants and creator businesses.
                      </p>
                    </div>
                  </div>

                  <a
                    href="https://bk.rw/merchants"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900 text-xs font-semibold transition-colors shrink-0"
                  >
                    <span>Learn More</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>

              {/* Verification & Test Suite Status Indicator */}
              <div className="pt-6 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500 font-mono">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-500" />
                  <span>
                    Revenue Invariants & Mathematical Split Tests: {testResults.filter((r) => r.passed).length}/{testResults.length} Passed
                  </span>
                </div>
                <div>Free Me Platform v1.0 · Kigali Hub</div>
              </div>
            </div>
          )}

          {/* VIEW: WATCH PAGE */}
          {currentView === 'watch' && selectedVideo && (
            <WatchPage
              video={selectedVideo}
              channel={channels.find((c) => c.id === selectedVideo.channelId)}
              comments={comments.filter((c) => c.videoId === selectedVideo.id)}
              relatedVideos={videos.filter((v) => v.id !== selectedVideo.id && !v.isShort)}
              activeAdCampaign={activeAdCampaign}
              currentUser={currentUser}
              currency={currency}
              onSelectVideo={handleSelectVideo}
              onSelectChannel={handleSelectChannel}
              onToggleLike={handleToggleLike}
              onToggleSubscribe={handleToggleSubscribe}
              isSubscribed={subscribedChannelIds.includes(selectedVideo.channelId)}
              onAddComment={handleAddComment}
              onAdImpressionCompleted={handleAdImpressionCompleted}
              onReportVideo={handleReportVideo}
            />
          )}

          {/* VIEW: SHORTS FEED */}
          {currentView === 'shorts' && (
            <ShortsFeed
              shorts={shortsList}
              currentUser={currentUser}
              onToggleLike={handleToggleLike}
              onToggleSubscribe={handleToggleSubscribe}
              subscribedChannelIds={subscribedChannelIds}
              onSelectChannel={handleSelectChannel}
              onAddComment={handleAddComment}
            />
          )}

          {/* VIEW: CREATOR STUDIO */}
          {currentView === 'studio' && (
            <CreatorStudio
              channel={channels[0]} // Clarisse Media default creator
              videos={videos}
              balance={balances[channels[0].id] || {
                channelId: channels[0].id,
                pendingBalanceRwf: 24500,
                confirmedBalanceRwf: 219500,
                lifetimeEarningsRwf: 485000,
                withdrawnRwf: 265500,
              }}
              ledger={ledger.filter((l) => l.channelId === channels[0].id)}
              payouts={payouts.filter((p) => p.channelId === channels[0].id)}
              currency={currency}
              currentUser={currentUser}
              onOpenUpload={() => setShowUploadModal(true)}
              onDeleteVideo={(vidId) => setVideos((prev) => prev.filter((v) => v.id !== vidId))}
              onToggleMonetization={(vidId) =>
                setVideos((prev) =>
                  prev.map((v) => (v.id === vidId ? { ...v, monetizationEnabled: !v.monetizationEnabled } : v))
                )
              }
              onRequestPayout={handleRequestPayout}
              onSelectVideo={handleSelectVideo}
            />
          )}

          {/* VIEW: ADVERTISER STUDIO */}
          {currentView === 'advertiser' && (
            <AdvertiserStudio
              campaigns={campaigns}
              currency={currency}
              currentUser={currentUser}
              onCreateCampaign={handleCreateCampaign}
            />
          )}

          {/* VIEW: ADMIN GOVERNANCE DESK */}
          {currentView === 'admin' && (
            <AdminDashboard
              campaigns={campaigns}
              payouts={payouts}
              reports={reports}
              auditLogs={auditLogs}
              settings={settings}
              currency={currency}
              currentUser={currentUser}
              onApproveCampaign={handleApproveCampaign}
              onRejectCampaign={handleRejectCampaign}
              onApprovePayout={handleApprovePayout}
              onRejectPayout={handleRejectPayout}
              onResolveReport={handleResolveReport}
              onUpdateSettings={(newSet) => setSettings(newSet)}
            />
          )}

          {/* VIEW: CHANNEL VIEW */}
          {currentView === 'channel' && (
            <ChannelView
              channel={currentChannel}
              videos={videos.filter((v) => v.channelId === currentChannel.id || v.channelName === currentChannel.name)}
              isSubscribed={subscribedChannelIds.includes(currentChannel.id)}
              onToggleSubscribe={handleToggleSubscribe}
              onSelectVideo={handleSelectVideo}
            />
          )}

          {/* VIEW: SUBSCRIPTIONS */}
          {currentView === 'subscriptions' && (
            <div className="max-w-[1520px] mx-auto px-4 md:px-8 py-6 space-y-6">
              <h2 className="font-display font-bold text-xl text-slate-900 dark:text-white">
                Your Subscribed African Channels
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {videos
                  .filter((v) => subscribedChannelIds.includes(v.channelId))
                  .map((vid) => (
                    <VideoCard
                      key={vid.id}
                      video={vid}
                      onSelect={handleSelectVideo}
                      onSelectChannel={handleSelectChannel}
                    />
                  ))}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Video Upload Modal */}
      {showUploadModal && (
        <VideoUploadModal
          onClose={() => setShowUploadModal(false)}
          onUploadComplete={handleUploadComplete}
        />
      )}
    </div>
  );
}
