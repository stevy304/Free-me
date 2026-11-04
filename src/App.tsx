/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  INITIAL_USERS,
  INITIAL_CHANNELS,
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
import { DISCOVERY_VIDEOS } from './services/discoveryCatalog';
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
    return localStorage.getItem('free-me-theme') === 'dark';
  });
  const [currency, setCurrency] = useState<'RWF' | 'USD'>('RWF');

  // Active User / Role Persona
  const [users, setUsers] = useState<User[]>(INITIAL_USERS);
  const [currentUser, setCurrentUser] = useState<User>(INITIAL_USERS[0]); // Viewer default

  // Domain State
  const [channels, setChannels] = useState<Channel[]>(INITIAL_CHANNELS);
  const [videos, setVideos] = useState<Video[]>(() => {
    try {
      const uploads: unknown = JSON.parse(localStorage.getItem('free-me-uploads') || '[]');
      return Array.isArray(uploads) ? [...uploads, ...DISCOVERY_VIDEOS] : DISCOVERY_VIDEOS;
    } catch {
      return DISCOVERY_VIDEOS;
    }
  });
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
    localStorage.setItem('free-me-theme', darkMode ? 'dark' : 'light');
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
    if (view === 'home' || view === 'explore') {
      setSelectedCategory('All Categories');
      setSearchQuery('');
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
      id: newVidData.id || `vid_${Date.now()}`,
      channelId: currentUser.channelId || defaultChannel.id,
      channelName: currentUser.channelId ? currentUser.displayName : defaultChannel.name,
      channelHandle: currentUser.channelId ? `@${currentUser.displayName.toLowerCase().replace(/\s+/g, '_')}` : defaultChannel.handle,
      channelAvatarUrl: currentUser.avatarUrl,
      channelVerified: false,
      title: newVidData.title || 'Untitled African Story',
      description: newVidData.description || '',
      category: newVidData.category || 'Kigali Life',
      tags: ['FreeMe', 'AfricanCreators', 'Rwanda'],
      status: 'READY',
      visibility: 'PUBLIC',
      durationSeconds: newVidData.durationSeconds ?? 0,
      thumbnailUrl: newVidData.thumbnailUrl ?? '',
      videoUrl: newVidData.videoUrl || 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      isShort: Boolean(newVidData.isShort),
      monetizationEnabled: Boolean(newVidData.monetizationEnabled),
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      createdAt: 'Just now',
      renditions: newVidData.renditions || [],
    };

    setVideos((prev) => [newVideo, ...prev]);
    try {
      const uploads = videos.filter((item) => item.videoUrl.startsWith('/api/media/'));
      localStorage.setItem('free-me-uploads', JSON.stringify([newVideo, ...uploads]));
    } catch (error) {
      console.warn('Could not save uploaded video to the local catalog', error);
    }
    handleSelectVideo(newVideo);

    // Audit log
    setAuditLogs((prev) => [
      {
        id: `audit_${Date.now()}`,
        timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
        adminName: currentUser.displayName,
        action: 'VIDEO_TRANSCODED',
        entityType: 'Video',
        entityId: newVideo.id,
        details: `Local HLS stream generated for "${newVideo.title}"`,
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
    if (v.isShort) return false; // Shorts have dedicated reel & page
    const isTravel = ['Kigali Life', 'Wildlife & Safari'].includes(v.category);
    if (selectedCategory === 'Travel' && !isTravel) return false;
    if (selectedCategory !== 'Travel' && selectedCategory !== 'All Categories' && v.category !== selectedCategory) return false;
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
    <div className="min-h-screen discovery-shell text-slate-900 dark:text-slate-100 flex flex-col font-sans transition-colors">
      {/* Top Bar adhering to Top Bar Contract */}
      <Header
        currentUser={currentUser}
        recentUploads={videos.filter((video) => video.videoUrl.startsWith('/api/media/')).slice(0, 3).map((video) => video.title)}
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
          setSelectedCategory('All Categories');
          setCurrentView('home');
        }}
      />

      <div className="flex-1 flex">
        <Sidebar currentView={currentView} onNavigate={handleNavigate} />
        <main className="flex-1 min-w-0 pb-16">
          {/* VIEW: HOME FEED */}
          {(currentView === 'home' || currentView === 'explore') && (
            <section className="discovery-feed">
              <h1>{searchQuery.trim() ? `Search results for “${searchQuery.trim()}”` : currentView === 'explore' ? 'Explore Free Me' : 'Discover Free Me'}</h1>
              <div className="discovery-categories" aria-label="Video categories">
                {[
                  ['All Categories', 'For you'],
                  ['Music & Performance', 'Music'],
                  ['Culinary & Coffee', 'Culture'],
                  ['Tech & Innovation', 'Tech'],
                  ['Travel', 'Travel'],
                ].map(([category, label]) => (
                  <button type="button" key={category} aria-pressed={selectedCategory === category}
                    onClick={() => setSelectedCategory(category)}>{label}</button>
                ))}
              </div>
              {filteredVideos.length ? (
                <div className="discovery-grid">
                  {filteredVideos.map((video) => (
                    <VideoCard key={video.id} video={video} onSelect={handleSelectVideo}
                      onSelectChannel={handleSelectChannel} />
                  ))}
                </div>
              ) : <p className="py-12 text-slate-500" role="status">No videos match this search.</p>}
              <p className="mt-8 text-xs text-slate-500 dark:text-slate-400">Preview catalog. Featured videos and engagement figures are sample content.</p>
            </section>
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
