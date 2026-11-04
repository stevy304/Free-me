import React, { useState } from 'react';
import {
  Users,
  Clock,
  Eye,
  Wallet,
  ArrowUpRight,
  TrendingUp,
  DollarSign,
  Plus,
  Play,
  CheckCircle2,
  Trash2,
  Lock,
  Smartphone,
  Building,
  CreditCard,
  AlertCircle,
  FileText,
  ShieldCheck,
  Check,
} from 'lucide-react';
import {
  Channel,
  Video,
  CreatorBalance,
  RevenueLedgerEntry,
  PayoutRequest,
  PayoutMethod,
  User,
} from '../../types';
import { formatCurrency, validatePayoutRequest } from '../../services/revenue';

interface CreatorStudioProps {
  channel: Channel;
  videos: Video[];
  balance: CreatorBalance;
  ledger: RevenueLedgerEntry[];
  payouts: PayoutRequest[];
  currency: 'RWF' | 'USD';
  currentUser: User;
  onOpenUpload: () => void;
  onDeleteVideo: (videoId: string) => void;
  onToggleMonetization: (videoId: string) => void;
  onRequestPayout: (amountRwf: number, method: PayoutMethod, accountIdentifier: string, accountHolderName: string) => void;
  onSelectVideo: (video: Video) => void;
}

export const CreatorStudio: React.FC<CreatorStudioProps> = ({
  channel,
  videos,
  balance,
  ledger,
  payouts,
  currency,
  currentUser,
  onOpenUpload,
  onDeleteVideo,
  onToggleMonetization,
  onRequestPayout,
  onSelectVideo,
}) => {
  const [activeTab, setActiveTab] = useState<'OVERVIEW' | 'VIDEOS' | 'LEDGER' | 'PAYOUTS' | 'ELIGIBILITY'>('OVERVIEW');
  const [showPayoutModal, setShowPayoutModal] = useState(false);
  const [payoutAmount, setPayoutAmount] = useState<string>('50000');
  const [payoutMethod, setPayoutMethod] = useState<PayoutMethod>('MTN_MOMO_RWANDA');
  const [accountIdentifier, setAccountIdentifier] = useState('');
  const [accountHolderName, setAccountHolderName] = useState(currentUser.displayName);
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [payoutSuccess, setPayoutSuccess] = useState(false);

  const creatorVideos = videos.filter((v) => v.channelId === channel.id || v.channelName === channel.name);

  const totalViews = creatorVideos.reduce((acc, v) => acc + v.viewCount, 0);
  const monetizedViews = creatorVideos
    .filter((v) => v.monetizationEnabled)
    .reduce((acc, v) => acc + v.viewCount, 0);

  const handlePayoutSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPayoutError(null);
    const amount = parseInt(payoutAmount, 10);
    if (isNaN(amount) || amount <= 0) {
      setPayoutError('Please enter a valid withdrawal amount.');
      return;
    }

    const validation = validatePayoutRequest(amount, balance);
    if (!validation.allowed) {
      setPayoutError(validation.reason || 'Invalid withdrawal amount.');
      return;
    }

    onRequestPayout(amount, payoutMethod, accountIdentifier, accountHolderName);
    setPayoutSuccess(true);
    setTimeout(() => {
      setShowPayoutModal(false);
      setPayoutSuccess(false);
      setPayoutAmount('50000');
    }, 1500);
  };

  return (
    <div className="workspace-page studio-page space-y-6">
      {/* Studio Header Bar */}
      <div className="workspace-hero">
        <div className="flex items-center gap-3">
          <img
            src={channel.avatarUrl}
            alt={channel.name}
            referrerPolicy="no-referrer"
            className="w-12 h-12 rounded-xl object-cover border border-slate-200 dark:border-slate-700"
          />
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="workspace-title">
                Creator Studio
              </h1>
              {channel.isVerified && <CheckCircle2 className="w-4 h-4 text-amber-500" />}
            </div>
            <p className="text-xs text-slate-500 font-mono">
              {channel.name} · {channel.handle}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowPayoutModal(true)}
            disabled={balance.confirmedBalanceRwf < 10000}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg border border-emerald-600/40 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 disabled:opacity-40 transition-colors"
          >
            <Wallet className="w-3.5 h-3.5 text-emerald-500" />
            <span>Request Payout</span>
          </button>

          <button
            onClick={onOpenUpload}
            className="workspace-primary"
          >
            <Plus className="w-4 h-4" />
            <span>Upload Video</span>
          </button>
        </div>
      </div>

      <p className="workspace-preview">Preview workspace · Financial and account activity shown here uses sample data.</p>

      {/* KPI Stats Strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Subscribers */}
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-slate-500 text-xs">
            <span>Subscribers</span>
            <Users className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-xl md:text-2xl font-bold font-display text-slate-900 dark:text-white tabular-nums">
            {channel.subscriberCount.toLocaleString()}
          </div>
          <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
            +1,420 this month
          </div>
        </div>

        {/* Watch Time */}
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-slate-500 text-xs">
            <span>Watch Hours</span>
            <Clock className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-xl md:text-2xl font-bold font-display text-slate-900 dark:text-white tabular-nums">
            {channel.watchHours.toLocaleString()}h
          </div>
          <div className="text-[11px] text-slate-500">
            Eligibility threshold: 4,000h
          </div>
        </div>

        {/* Confirmed Balance */}
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-slate-500 text-xs">
            <span>Confirmed Balance</span>
            <Wallet className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="text-xl md:text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400 tabular-nums">
            {formatCurrency(balance.confirmedBalanceRwf, currency)}
          </div>
          <div className="text-[11px] text-slate-500">
            Ready for Mobile Money withdrawal
          </div>
        </div>

        {/* Pending Ad Pool */}
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-slate-500 text-xs">
            <span>Pending 60% Ad Pool</span>
            <TrendingUp className="w-4 h-4 text-amber-500" />
          </div>
          <div className="text-xl md:text-2xl font-bold font-mono text-amber-600 dark:text-amber-400 tabular-nums">
            {formatCurrency(balance.pendingBalanceRwf, currency)}
          </div>
          <div className="text-[11px] text-slate-500">
            Settles on 1st of month
          </div>
        </div>
      </div>

      {/* Studio Navigation Tabs */}
      <div className="workspace-tabs">
        {[
          { id: 'OVERVIEW', label: 'Channel Overview' },
          { id: 'VIDEOS', label: `Manage Videos (${creatorVideos.length})` },
          { id: 'LEDGER', label: 'Audited Revenue Ledger' },
          { id: 'PAYOUTS', label: `Payout History (${payouts.length})` },
          { id: 'ELIGIBILITY', label: 'Monetization Program' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`px-4 py-2.5 border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-amber-600 text-amber-600 dark:text-amber-400 font-semibold'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* TAB 1: OVERVIEW */}
      {activeTab === 'OVERVIEW' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {/* Transparent Economics Banner */}
            <div className="p-5 rounded-2xl bg-gradient-to-br from-amber-500/10 via-amber-500/5 to-transparent border border-amber-500/20 space-y-2">
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 font-semibold text-sm">
                <DollarSign className="w-4 h-4" />
                <span>Transparent African Creator Economics</span>
              </div>
              <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                Every Rwandan and African business advertising on Free Me shares <span className="font-bold text-slate-900 dark:text-white">60%</span> of their gross budget directly into the creator pool.
                Payments are disbursed via <span className="font-semibold text-slate-900 dark:text-white">MTN Mobile Money</span> and <span className="font-semibold text-slate-900 dark:text-white">Bank of Kigali</span> without foreign currency conversion deductions.
              </p>
            </div>

            {/* Recent Video Performance */}
            <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-4">
              <h3 className="font-display font-bold text-sm text-slate-900 dark:text-white">
                Latest Content Performance
              </h3>
              <div className="space-y-3">
                {creatorVideos.slice(0, 3).map((vid) => (
                  <div
                    key={vid.id}
                    onClick={() => onSelectVideo(vid)}
                    className="flex items-center justify-between p-3 rounded-xl border border-slate-100 dark:border-slate-800/80 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <img
                        src={vid.thumbnailUrl}
                        alt={vid.title}
                        referrerPolicy="no-referrer"
                        className="w-16 h-10 object-cover rounded-lg shrink-0"
                      />
                      <div className="min-w-0">
                        <h4 className="font-medium text-xs text-slate-900 dark:text-white truncate">
                          {vid.title}
                        </h4>
                        <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                          {vid.viewCount.toLocaleString()} views · {vid.likeCount} likes
                        </div>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="text-xs font-mono font-bold text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(Math.round((vid.viewCount / 1000) * 6500 * 0.6), currency)}
                      </span>
                      <div className="text-[10px] text-slate-400">Est. Creator Share</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Quick Actions & Payout Summary */}
          <div className="space-y-6">
            <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-4">
              <h3 className="font-display font-bold text-sm text-slate-900 dark:text-white">
                Payout Channels
              </h3>
              <div className="space-y-2.5 text-xs">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <Smartphone className="w-4 h-4 text-amber-500" />
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">MTN Mobile Money</div>
                      <div className="text-[11px] text-slate-500 font-mono">Demo mobile wallet</div>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                    Primary
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <Building className="w-4 h-4 text-blue-500" />
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">Bank of Kigali</div>
                      <div className="text-[11px] text-slate-500 font-mono">Demo bank account</div>
                    </div>
                  </div>
                  <span className="text-[10px] text-slate-400">Backup</span>
                </div>
              </div>

              <div className="pt-2">
                <button
                  onClick={() => setShowPayoutModal(true)}
                  className="w-full py-2.5 px-4 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-semibold text-xs transition-colors shadow-sm"
                >
                  Withdraw Available Balance
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: VIDEOS TABLE */}
      {activeTab === 'VIDEOS' && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 border-b border-slate-200 dark:border-slate-800 font-medium">
                <tr>
                  <th className="py-3 px-4">Video</th>
                  <th className="py-3 px-4">Visibility</th>
                  <th className="py-3 px-4">Monetization (60%)</th>
                  <th className="py-3 px-4 text-right">Views</th>
                  <th className="py-3 px-4 text-right">Comments</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {creatorVideos.map((vid) => (
                  <tr key={vid.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3 max-w-md">
                        <img
                          src={vid.thumbnailUrl}
                          alt={vid.title}
                          referrerPolicy="no-referrer"
                          className="w-14 h-9 object-cover rounded-md shrink-0 cursor-pointer"
                          onClick={() => onSelectVideo(vid)}
                        />
                        <div className="min-w-0">
                          <div
                            onClick={() => onSelectVideo(vid)}
                            className="font-semibold text-slate-900 dark:text-white truncate cursor-pointer hover:text-amber-600"
                          >
                            {vid.title}
                          </div>
                          <div className="text-[11px] text-slate-400">{vid.category}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="font-mono text-[11px] text-slate-600 dark:text-slate-300">
                        {vid.visibility}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <button
                        onClick={() => onToggleMonetization(vid.id)}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                          vid.monetizationEnabled
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                            : 'bg-slate-100 text-slate-500 dark:bg-slate-800'
                        }`}
                      >
                        {vid.monetizationEnabled ? 'Active (60% Share)' : 'Disabled'}
                      </button>
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900 dark:text-white">
                      {vid.viewCount.toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-500">
                      {vid.commentCount}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => onDeleteVideo(vid.id)}
                        title="Delete video"
                        className="p-1.5 rounded text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: AUDITED REVENUE LEDGER */}
      {activeTab === 'LEDGER' && (
        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300">
            <span className="font-semibold text-slate-900 dark:text-white">Double-Entry Audit Trail:</span>{' '}
            Every row in this ledger directly matches an advertiser campaign impression or a reconciled platform distribution. No unverified balances exist.
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 border-b border-slate-200 dark:border-slate-800 font-medium">
                  <tr>
                    <th className="py-3 px-4">Timestamp</th>
                    <th className="py-3 px-4">Event Source</th>
                    <th className="py-3 px-4">Description</th>
                    <th className="py-3 px-4 text-right">Gross Ad Pool</th>
                    <th className="py-3 px-4 text-right font-bold text-emerald-600 dark:text-emerald-400">
                      Creator (60%)
                    </th>
                    <th className="py-3 px-4 text-right">Platform (30%)</th>
                    <th className="py-3 px-4 text-right">Reinvest (10%)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                  {ledger.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="py-3 px-4 text-slate-500 text-[11px] whitespace-nowrap">
                        {entry.createdAt}
                      </td>
                      <td className="py-3 px-4 font-semibold text-slate-800 dark:text-slate-200">
                        {entry.sourceType}
                      </td>
                      <td className="py-3 px-4 font-sans text-slate-600 dark:text-slate-300 max-w-sm">
                        {entry.description}
                      </td>
                      <td className="py-3 px-4 text-right text-slate-600 dark:text-slate-300 tabular-nums">
                        {formatCurrency(entry.grossAmountRwf, currency)}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                        +{formatCurrency(entry.creatorShareRwf, currency)}
                      </td>
                      <td className="py-3 px-4 text-right text-slate-400 tabular-nums">
                        {formatCurrency(entry.platformShareRwf, currency)}
                      </td>
                      <td className="py-3 px-4 text-right text-slate-400 tabular-nums">
                        {formatCurrency(entry.reinvestShareRwf, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: PAYOUTS */}
      {activeTab === 'PAYOUTS' && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 border-b border-slate-200 dark:border-slate-800 font-medium">
                <tr>
                  <th className="py-3 px-4">Payout ID</th>
                  <th className="py-3 px-4">Method</th>
                  <th className="py-3 px-4">Account Identifier</th>
                  <th className="py-3 px-4 text-right">Amount</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Requested At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {payouts.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-4 font-mono text-slate-500">{p.id}</td>
                    <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">
                      {p.method === 'MTN_MOMO_RWANDA'
                        ? 'MTN MoMo Rwanda'
                        : p.method === 'BANK_TRANSFER_BK'
                        ? 'Bank of Kigali'
                        : p.method}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-300">
                      {p.accountIdentifier} ({p.accountHolderName})
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                      {formatCurrency(p.amountRwf, currency)}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                          p.status === 'PAID'
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400'
                            : p.status === 'APPROVED'
                            ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                            : 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400'
                        }`}
                      >
                        {p.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-slate-500">{p.requestedAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 5: ELIGIBILITY */}
      {activeTab === 'ELIGIBILITY' && (
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="p-6 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-950/50 flex items-center justify-center text-amber-600">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-display font-bold text-base text-slate-900 dark:text-white">
                  Free Me Partner Program
                </h3>
                <p className="text-xs text-slate-500">
                  Requirements to monetize and receive 60% advertising share in Rwanda
                </p>
              </div>
            </div>

            {/* Criteria 1: 1,000 Subscribers */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold">
                <span className="text-slate-800 dark:text-slate-200">1,000 Subscribers</span>
                <span className="font-mono text-emerald-600 dark:text-emerald-400">
                  {channel.subscriberCount.toLocaleString()} / 1,000 (Met)
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full"
                  style={{ width: `${Math.min(100, (channel.subscriberCount / 1000) * 100)}%` }}
                />
              </div>
            </div>

            {/* Criteria 2: 4,000 Watch Hours */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold">
                <span className="text-slate-800 dark:text-slate-200">4,000 Public Watch Hours</span>
                <span className="font-mono text-emerald-600 dark:text-emerald-400">
                  {channel.watchHours.toLocaleString()}h / 4,000h (Met)
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full"
                  style={{ width: `${Math.min(100, (channel.watchHours / 4000) * 100)}%` }}
                />
              </div>
            </div>

            <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-500/20 text-xs text-emerald-800 dark:text-emerald-300 flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold">Monetization Active & Verified:</span> You are an approved Free Me Creator Partner. All compliant local advertising revenue generated by your videos automatically flows into your audited balance.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* WITHDRAWAL / PAYOUT REQUEST MODAL */}
      {showPayoutModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl p-6 space-y-4">
            <h3 className="font-display font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
              <Wallet className="w-5 h-5 text-emerald-500" />
              <span>Withdraw Creator Earnings</span>
            </h3>

            {payoutSuccess ? (
              <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 text-xs flex items-center gap-2">
                <Check className="w-4 h-4" />
                <span>Withdrawal requested successfully! Processing via MTN MoMo / Bank API.</span>
              </div>
            ) : (
              <form onSubmit={handlePayoutSubmit} className="space-y-4 text-xs">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 flex justify-between items-center">
                  <span className="text-slate-500">Available to withdraw:</span>
                  <span className="font-mono font-bold text-sm text-emerald-600 dark:text-emerald-400">
                    {formatCurrency(balance.confirmedBalanceRwf, currency)}
                  </span>
                </div>

                {payoutError && (
                  <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-500/20 text-rose-600 text-xs">
                    {payoutError}
                  </div>
                )}

                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Amount (RWF) *
                  </label>
                  <input
                    type="number"
                    min={10000}
                    step={1000}
                    value={payoutAmount}
                    onChange={(e) => setPayoutAmount(e.target.value)}
                    className="w-full px-3.5 py-2 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                  <span className="text-[11px] text-slate-400 mt-1 block">
                    Minimum threshold: 10,000 RWF (~$7.60 USD)
                  </span>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Payment Method *
                  </label>
                  <select
                    value={payoutMethod}
                    onChange={(e) => setPayoutMethod(e.target.value as any)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none"
                  >
                    <option value="MTN_MOMO_RWANDA">MTN Mobile Money Rwanda (Instant)</option>
                    <option value="AIRTEL_MONEY_RWANDA">Airtel Money Rwanda</option>
                    <option value="BANK_TRANSFER_BK">Bank of Kigali (BK) Wire</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Phone Number or Account Number *
                  </label>
                  <input
                    type="text"
                    required
                    value={accountIdentifier}
                    onChange={(e) => setAccountIdentifier(e.target.value)}
                    placeholder="+250 788..."
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-white focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Account Holder Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={accountHolderName}
                    onChange={(e) => setAccountHolderName(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => setShowPayoutModal(false)}
                    className="px-4 py-2 text-slate-500 hover:text-slate-700 font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg shadow-sm"
                  >
                    Confirm Withdrawal
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
