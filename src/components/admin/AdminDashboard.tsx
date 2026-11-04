import React, { useState } from 'react';
import {
  ShieldAlert,
  CheckCircle2,
  XCircle,
  TrendingUp,
  Users,
  Wallet,
  Megaphone,
  Sliders,
  FileText,
  AlertTriangle,
  RotateCcw,
  Check,
  Building,
} from 'lucide-react';
import {
  Campaign,
  PayoutRequest,
  ModerationReport,
  AuditLogItem,
  PlatformSettings,
  User,
} from '../../types';
import { formatCurrency } from '../../services/revenue';

interface AdminDashboardProps {
  campaigns: Campaign[];
  payouts: PayoutRequest[];
  reports: ModerationReport[];
  auditLogs: AuditLogItem[];
  settings: PlatformSettings;
  currency: 'RWF' | 'USD';
  currentUser: User;
  onApproveCampaign: (campaignId: string) => void;
  onRejectCampaign: (campaignId: string) => void;
  onApprovePayout: (payoutId: string) => void;
  onRejectPayout: (payoutId: string) => void;
  onResolveReport: (reportId: string, action: 'RESOLVED' | 'DISMISSED') => void;
  onUpdateSettings: (newSettings: PlatformSettings) => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  campaigns,
  payouts,
  reports,
  auditLogs,
  settings,
  currency,
  currentUser,
  onApproveCampaign,
  onRejectCampaign,
  onApprovePayout,
  onRejectPayout,
  onResolveReport,
  onUpdateSettings,
}) => {
  const [activeTab, setActiveTab] = useState<'CAMPAIGNS' | 'PAYOUTS' | 'MODERATION' | 'SETTINGS' | 'LOGS'>('CAMPAIGNS');

  // Revenue settings local editing state
  const [creatorPool, setCreatorPool] = useState(settings.creatorPoolPercent);
  const [platformOps, setPlatformOps] = useState(settings.platformOpsPercent);
  const [reinvest, setReinvest] = useState(settings.reinvestmentPercent);
  const [savedSettingsSuccess, setSavedSettingsSuccess] = useState(false);

  const pendingCampaigns = campaigns.filter((c) => c.status === 'PENDING_REVIEW');
  const pendingPayouts = payouts.filter((p) => p.status === 'REQUESTED');
  const pendingReports = reports.filter((r) => r.status === 'PENDING');

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    if (creatorPool + platformOps + reinvest !== 100) {
      alert('The sum of creator pool, platform ops, and reinvestment must equal exactly 100%.');
      return;
    }
    onUpdateSettings({
      ...settings,
      creatorPoolPercent: creatorPool,
      platformOpsPercent: platformOps,
      reinvestmentPercent: reinvest,
    });
    setSavedSettingsSuccess(true);
    setTimeout(() => setSavedSettingsSuccess(false), 2000);
  };

  return (
    <div className="max-w-[1440px] mx-auto px-4 md:px-8 py-6 space-y-6">
      {/* Admin Title */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-rose-50 dark:bg-rose-950/50 flex items-center justify-center text-rose-600">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <div>
            <h1 className="font-display font-extrabold text-xl text-slate-900 dark:text-white">
              Free Me Platform Governance Desk
            </h1>
            <p className="text-xs text-slate-500 font-mono">
              Audit Trails, Advertising Verification & Creator Payout Disbursals
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs font-mono px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
          <span>Admin Operator:</span>
          <span className="font-bold text-slate-900 dark:text-white">{currentUser.displayName}</span>
        </div>
      </div>

      {/* KPI Overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-slate-500 text-xs">
            <span>Pending Campaigns</span>
            <Megaphone className="w-4 h-4 text-blue-500" />
          </div>
          <div className="text-2xl font-bold font-display text-slate-900 dark:text-white tabular-nums">
            {pendingCampaigns.length}
          </div>
          <div className="text-[11px] text-slate-500">Awaiting compliance review</div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-slate-500 text-xs">
            <span>Pending Payouts</span>
            <Wallet className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="text-2xl font-bold font-display text-slate-900 dark:text-white tabular-nums">
            {pendingPayouts.length}
          </div>
          <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
            MTN MoMo & Bank approvals
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-slate-500 text-xs">
            <span>Open Reports</span>
            <AlertTriangle className="w-4 h-4 text-rose-500" />
          </div>
          <div className="text-2xl font-bold font-display text-slate-900 dark:text-white tabular-nums">
            {pendingReports.length}
          </div>
          <div className="text-[11px] text-slate-500">Copyright & safety flags</div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-slate-500 text-xs">
            <span>Split Policy</span>
            <Sliders className="w-4 h-4 text-amber-500" />
          </div>
          <div className="text-xl font-bold font-mono text-slate-900 dark:text-white">
            {settings.creatorPoolPercent}/{settings.platformOpsPercent}/{settings.reinvestmentPercent}
          </div>
          <div className="text-[11px] text-slate-500">Creator / Ops / Reinvest</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800 text-xs font-medium">
        {[
          { id: 'CAMPAIGNS', label: `Ad Campaign Review (${pendingCampaigns.length})` },
          { id: 'PAYOUTS', label: `Creator Payout Approvals (${pendingPayouts.length})` },
          { id: 'MODERATION', label: `Moderation Reports (${pendingReports.length})` },
          { id: 'SETTINGS', label: 'Revenue Split Governance' },
          { id: 'LOGS', label: `Immutable Audit Logs (${auditLogs.length})` },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`px-4 py-2.5 border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-rose-600 text-rose-600 dark:text-rose-400 font-semibold'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* TAB 1: CAMPAIGN REVIEWS */}
      {activeTab === 'CAMPAIGNS' && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 border-b border-slate-200 dark:border-slate-800 font-medium">
                <tr>
                  <th className="py-3 px-4">Business & Campaign</th>
                  <th className="py-3 px-4">Format</th>
                  <th className="py-3 px-4">Audience</th>
                  <th className="py-3 px-4 text-right">Budget</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {campaigns.map((camp) => (
                  <tr key={camp.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-white">{camp.name}</div>
                      <div className="text-[11px] text-slate-500 font-mono">
                        {camp.businessName} · {camp.headline}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 font-mono text-[11px] text-slate-600 dark:text-slate-300">
                      {camp.adFormat}
                    </td>
                    <td className="py-3.5 px-4 text-[11px] font-mono text-slate-600 dark:text-slate-300">
                      {camp.targetCountry} ({camp.targetCategory})
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                      {formatCurrency(camp.budgetAmountRwf, currency)}
                    </td>
                    <td className="py-3.5 px-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                          camp.status === 'ACTIVE'
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400'
                            : camp.status === 'PENDING_REVIEW'
                            ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {camp.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      {camp.status === 'PENDING_REVIEW' ? (
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => onApproveCampaign(camp.id)}
                            className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-[11px] flex items-center gap-1 shadow-sm"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Approve</span>
                          </button>
                          <button
                            onClick={() => onRejectCampaign(camp.id)}
                            className="px-2.5 py-1 rounded bg-rose-600 hover:bg-rose-700 text-white font-semibold text-[11px] flex items-center gap-1"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            <span>Reject</span>
                          </button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-400 font-mono">Reviewed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: CREATOR PAYOUT APPROVALS */}
      {activeTab === 'PAYOUTS' && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 border-b border-slate-200 dark:border-slate-800 font-medium">
                <tr>
                  <th className="py-3 px-4">Channel / Recipient</th>
                  <th className="py-3 px-4">Method & Account</th>
                  <th className="py-3 px-4 text-right">Amount</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Requested</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {payouts.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {p.channelName}
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono">{p.accountHolderName}</div>
                    </td>
                    <td className="py-3.5 px-4 font-mono text-[11px] text-slate-700 dark:text-slate-300">
                      {p.method} · {p.accountIdentifier}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                      {formatCurrency(p.amountRwf, currency)}
                    </td>
                    <td className="py-3.5 px-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                          p.status === 'PAID'
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400'
                            : p.status === 'REQUESTED'
                            ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {p.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-[11px] font-mono text-slate-500">{p.requestedAt}</td>
                    <td className="py-3.5 px-4 text-right">
                      {p.status === 'REQUESTED' ? (
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => onApprovePayout(p.id)}
                            className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-semibold text-[11px] shadow-sm"
                          >
                            Disburse via MoMo
                          </button>
                          <button
                            onClick={() => onRejectPayout(p.id)}
                            className="px-2 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded font-semibold text-[11px]"
                          >
                            Reject
                          </button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-400 font-mono">Disbursed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: MODERATION REPORTS */}
      {activeTab === 'MODERATION' && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 border-b border-slate-200 dark:border-slate-800 font-medium">
                <tr>
                  <th className="py-3 px-4">Reported Video</th>
                  <th className="py-3 px-4">Reason</th>
                  <th className="py-3 px-4">Details</th>
                  <th className="py-3 px-4">Reporter</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Moderator Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {reports.map((rep) => (
                  <tr key={rep.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3.5 px-4 font-semibold text-slate-900 dark:text-white">
                      {rep.videoTitle}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-rose-600 font-bold">{rep.reason}</td>
                    <td className="py-3.5 px-4 text-slate-600 dark:text-slate-300 max-w-sm">
                      {rep.details}
                    </td>
                    <td className="py-3.5 px-4 text-slate-500 font-mono">{rep.reporterName}</td>
                    <td className="py-3.5 px-4">
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400">
                        {rep.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      {rep.status === 'PENDING' ? (
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => onResolveReport(rep.id, 'RESOLVED')}
                            className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded text-[11px] font-semibold"
                          >
                            Take Action
                          </button>
                          <button
                            onClick={() => onResolveReport(rep.id, 'DISMISSED')}
                            className="px-2.5 py-1 bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-200 rounded text-[11px]"
                          >
                            Dismiss
                          </button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-400 font-mono">Closed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: REVENUE SPLIT GOVERNANCE */}
      {activeTab === 'SETTINGS' && (
        <div className="max-w-xl mx-auto space-y-6">
          <form onSubmit={handleSaveSettings} className="p-6 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-5 text-xs">
            <div className="flex items-center gap-2.5 pb-3 border-b border-slate-100 dark:border-slate-800">
              <Sliders className="w-5 h-5 text-amber-600" />
              <div>
                <h3 className="font-display font-bold text-base text-slate-900 dark:text-white">
                  Platform Revenue Sharing Policy
                </h3>
                <p className="text-[11px] text-slate-500">
                  Configure the core economic parameters of Free Me platform.
                </p>
              </div>
            </div>

            {savedSettingsSuccess && (
              <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                <Check className="w-4 h-4" />
                <span>Revenue split policy updated and logged to audit trail!</span>
              </div>
            )}

            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Creator Pool Share (%): {creatorPool}%
              </label>
              <input
                type="range"
                min={50}
                max={85}
                value={creatorPool}
                onChange={(e) => setCreatorPool(parseInt(e.target.value, 10))}
                className="w-full accent-emerald-600 cursor-pointer"
              />
              <span className="text-[11px] text-slate-400">
                Directly credited to verified African creators.
              </span>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Platform Infrastructure & Operations (%): {platformOps}%
              </label>
              <input
                type="range"
                min={10}
                max={40}
                value={platformOps}
                onChange={(e) => setPlatformOps(parseInt(e.target.value, 10))}
                className="w-full accent-blue-600 cursor-pointer"
              />
              <span className="text-[11px] text-slate-400">
                Hetzner dedicated servers, bandwidth, FFmpeg transcoding nodes, database.
              </span>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Community Reinvestment & Creator Grants (%): {reinvest}%
              </label>
              <input
                type="range"
                min={5}
                max={25}
                value={reinvest}
                onChange={(e) => setReinvest(parseInt(e.target.value, 10))}
                className="w-full accent-amber-600 cursor-pointer"
              />
              <span className="text-[11px] text-slate-400">
                Local creator equipment grants, storytelling workshops in Kigali.
              </span>
            </div>

            <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 font-mono text-center text-xs">
              Total Allocation: <span className="font-bold">{creatorPool + platformOps + reinvest}%</span> / 100%
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                className="px-5 py-2 font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg shadow-sm transition-colors"
              >
                Update Split Parameters
              </button>
            </div>
          </form>
        </div>
      )}

      {/* TAB 5: AUDIT LOGS */}
      {activeTab === 'LOGS' && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 border-b border-slate-200 dark:border-slate-800 font-medium">
                <tr>
                  <th className="py-3 px-4">Timestamp</th>
                  <th className="py-3 px-4">Operator</th>
                  <th className="py-3 px-4">Action</th>
                  <th className="py-3 px-4">Entity</th>
                  <th className="py-3 px-4">Audit Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-4 text-slate-500 text-[11px] whitespace-nowrap">
                      {log.timestamp}
                    </td>
                    <td className="py-3 px-4 font-semibold text-slate-800 dark:text-slate-200 font-sans">
                      {log.adminName}
                    </td>
                    <td className="py-3 px-4 font-bold text-amber-600 dark:text-amber-400">
                      {log.action}
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">
                      {log.entityType} ({log.entityId})
                    </td>
                    <td className="py-3 px-4 font-sans text-slate-700 dark:text-slate-300 max-w-md">
                      {log.details}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
