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
import { toCatalogVideo, type ReadyUpload } from './services/videoCatalog';
import { DISCOVERY_VIDEOS } from './services/discoveryCatalog';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';
import { DiscoveryPage } from './pages/DiscoveryPage';
import { pageUrl, readRoute } from './services/routes';
import { WatchPage } from './components/video/WatchPage';
import { ShortsFeed } from './components/shorts/ShortsFeed';
import { CreatorStudio } from './components/studio/CreatorStudio';
import { UploadPage } from './pages/UploadPage';
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
    return localStorage.getItem('free-me-theme') !== 'light';
  });
  const [currency, setCurrency] = useState<'RWF' | 'USD'>('RWF');

  // Active User / Role Persona
  const [users, setUsers] = useState<User[]>(INITIAL_USERS);
  const [currentUser, setCurrentUser] = useState<User>(INITIAL_USERS[0]); // Viewer default

  // Domain State
  const [channels, setChannels] = useState<Channel[]>(INITIAL_CHANNELS);
  const [videos, setVideos] = useState<Video[]>(DISCOVERY_VIDEOS);
  useEffect(() => {
    const controller = new AbortController();
    async function loadCatalog() {
      try {
        const response = await fetch('/api/videos', { signal: controller.signal });
        if (!response.ok) return;
        const { videos: uploads }: { videos: ReadyUpload[] } = await response.json();
        setVideos((current) => {
          const known = new Set(current.map((video) => video.id));
          return [...uploads.filter((video) => !known.has(video.id)).map(toCatalogVideo), ...current];
        });
      } catch (error) {
        if (!controller.signal.aborted) console.warn('Local video catalog is unavailable', error);
      }
    }
    void loadCatalog();
    return () => controller.abort();
  }, []);
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
  const [navigationExpanded, setNavigationExpanded] = useState(false);
  useEffect(() => {
    if (!navigationExpanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNavigationExpanded(false);
        document.getElementById('navigation-toggle')?.focus();
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [navigationExpanded]);

  const [route, setRoute] = useState(() => readRoute(window.location));
  const currentView = route.view;
  const selectedVideoId = route.view === 'watch' ? route.id : null;
  const selectedVideo = videos.find((video) => video.id === selectedVideoId);
  const selectedChannelId = route.view === 'channel' ? route.id : null;
  const [selectedCategory, setSelectedCategory] = useState('All Categories');
  const [searchQuery, setSearchQuery] = useState(() => route.view === 'search' ? route.query : '');
  const [unavailableId, setUnavailableId] = useState<string | null>(null);

  useEffect(() => {
    function restoreRoute() {
      const next = readRoute(window.location);
      setRoute(next);
      setSelectedCategory('All Categories');
      setSearchQuery(next.view === 'search' ? next.query : '');
    }
    window.addEventListener('popstate', restoreRoute);
    return () => window.removeEventListener('popstate', restoreRoute);
  }, []);

  useEffect(() => {
    if (!selectedVideoId || selectedVideo) return;
    if (!/^[a-f0-9-]{36}$/.test(selectedVideoId)) {
      setUnavailableId(selectedVideoId);
      return;
    }
    setUnavailableId(null);
    const controller = new AbortController();
    async function loadVideo(id: string) {
      try {
        const response = await fetch('/api/videos/' + encodeURIComponent(id), { signal: controller.signal });
        if (!response.ok) throw new Error('Video unavailable');
        const upload: ReadyUpload = await response.json();
        if (upload.status !== 'ready' || !upload.playlistUrl) throw new Error('Video unavailable');
        setVideos((current) => current.some((video) => video.id === id) ? current : [toCatalogVideo(upload), ...current]);
      } catch {
        if (!controller.signal.aborted) setUnavailableId(id);
      }
    }
    void loadVideo(selectedVideoId);
    return () => controller.abort();
  }, [selectedVideoId, selectedVideo]);

  useEffect(() => {
    const title = selectedVideo?.title || (route.view === 'search' ? 'Search' : route.view === 'home' ? 'Discover' : route.view.replaceAll('-', ' '));
    document.title = title.charAt(0).toUpperCase() + title.slice(1) + ' · Free Me';
  }, [route, selectedVideo?.title]);

  // Modals


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

  const handleNavigate = (view: string, value?: string) => {
    setNavigationExpanded(false);
    const url = pageUrl(view, value);
    if (window.location.pathname + window.location.search !== url) window.history.pushState(null, '', url);
    setRoute(readRoute(window.location));
    setSelectedCategory('All Categories');
    setSearchQuery(view === 'search' ? value || '' : '');
    window.scrollTo({ top: 0 });
  };

  const handleSelectVideo = (video: Video) => handleNavigate('watch', video.id);
  const handleSelectChannel = (channelId: string) => {
    if (channels.some((channel) => channel.id === channelId)) handleNavigate('channel', channelId);
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
  const handleUploadComplete = (upload: ReadyUpload) => {
    const newVideo = toCatalogVideo(upload);
    setVideos((current) => [newVideo, ...current.filter((video) => video.id !== newVideo.id)]);
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
    if (route.view === 'search' && route.query.trim()) {
      const q = route.query.trim().toLowerCase();
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
  const currentChannel = channels.find((c) => c.id === selectedChannelId);

  return (
    <div className="min-h-screen discovery-shell text-slate-900 dark:text-slate-100 flex flex-col font-sans transition-colors">
      {/* Top Bar adhering to Top Bar Contract */}
      <Header
        currentUser={currentUser}
        navigationExpanded={navigationExpanded}
        onToggleNavigation={() => setNavigationExpanded((expanded) => !expanded)}
        recentUploads={videos.filter((video) => video.videoUrl.startsWith('/api/media/')).slice(0, 3).map((video) => video.title)}
        users={users}
        onSelectUser={(u) => {
          setCurrentUser(u);
          if (u.role === 'CREATOR') handleNavigate('studio');
          else if (u.role === 'ADVERTISER') handleNavigate('advertiser');
          else if (u.role === 'ADMIN') handleNavigate('admin');
        }}
        currency={currency}
        onToggleCurrency={toggleCurrency}
        darkMode={darkMode}
        onToggleDarkMode={toggleDarkMode}
        onOpenUpload={() => handleNavigate('upload')}
        onNavigate={handleNavigate}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSearchSubmit={(e) => {
          e.preventDefault();
          const query = searchQuery.trim();
          if (query) handleNavigate('search', query);
        }}
      />

      <div className={`flex-1 flex ${currentView === 'watch' ? 'watch-layout' : ''}`}>
        {navigationExpanded && <div className="navigation-backdrop" aria-hidden="true"
          onClick={() => {
            setNavigationExpanded(false);
            document.getElementById('navigation-toggle')?.focus();
          }} />}
        <Sidebar currentView={currentView} expanded={navigationExpanded} onNavigate={handleNavigate} />
        <main className="flex-1 min-w-0 pb-16">
          {(currentView === 'home' || currentView === 'explore' || route.view === 'search') && (
            <DiscoveryPage
              title={route.view === 'search' ? `Search results for “${route.query}”` : currentView === 'explore' ? 'Explore Free Me' : 'Discover Free Me'}
              compactHeading={currentView === 'home'}
              category={selectedCategory} onCategory={setSelectedCategory}
              videos={filteredVideos} onSelectVideo={handleSelectVideo} onSelectChannel={handleSelectChannel}
            />
          )}

          {((currentView === 'watch' && !selectedVideo) || (currentView === 'channel' && !currentChannel) || currentView === 'not-found') && (
            <section className="discovery-feed" role="status">
              <h1>{currentView === 'watch' ? unavailableId === selectedVideoId ? 'Video unavailable' : 'Loading video…' : 'Page unavailable'}</h1>
              <a href="/" className="mt-5 inline-block underline">Back to Free Me</a>
            </section>
          )}

          {/* VIEW: WATCH PAGE */}
          {currentView === 'watch' && selectedVideo && (
            <WatchPage
              key={selectedVideo.id}
              video={selectedVideo}
              channel={channels.find((c) => c.id === selectedVideo.channelId)}
              comments={comments.filter((c) => c.videoId === selectedVideo.id)}
              relatedVideos={videos.filter((v) => v.id !== selectedVideo.id && !v.isShort && v.status === 'READY' && v.visibility === 'PUBLIC').sort((a, b) => Number(b.category === selectedVideo.category) - Number(a.category === selectedVideo.category)).slice(0, 12)}
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
              onOpenUpload={() => handleNavigate('upload')}
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
          {currentView === 'admin' && currentUser.role !== 'ADMIN' && (
            <section className="discovery-feed">
              <h1>Admin access required</h1>
              <p className="mt-4">Select the administrator preview account to open this page.</p>
            </section>
          )}
          {currentView === 'admin' && currentUser.role === 'ADMIN' && (
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
          {currentView === 'channel' && currentChannel && (
            <ChannelView
              channel={currentChannel}
              videos={videos.filter((v) => v.channelId === currentChannel.id || v.channelName === currentChannel.name)}
              isSubscribed={subscribedChannelIds.includes(currentChannel.id)}
              onToggleSubscribe={handleToggleSubscribe}
              onSelectVideo={handleSelectVideo}
            />
          )}

          {currentView === 'upload' && (
            <UploadPage onBack={() => handleNavigate('studio')} onUploadComplete={handleUploadComplete} />
          )}
          {currentView === 'subscriptions' && (
            <DiscoveryPage title="Subscriptions" videos={videos.filter((video) => subscribedChannelIds.includes(video.channelId))}
              onSelectVideo={handleSelectVideo} onSelectChannel={handleSelectChannel}
              emptyMessage="New videos from channels you subscribe to will appear here." />
          )}
        </main>
      </div>

    </div>
  );
}
