import React, { useState } from 'react';
import {
  Megaphone,
  Plus,
  TrendingUp,
  DollarSign,
  Target,
  Globe2,
  CheckCircle2,
  ExternalLink,
  Layers,
  X,
  Check,
  Building,
  BarChart2,
} from 'lucide-react';
import { Campaign, AdFormat, User } from '../../types';
import { formatCurrency } from '../../services/revenue';

interface AdvertiserStudioProps {
  campaigns: Campaign[];
  currency: 'RWF' | 'USD';
  currentUser: User;
  onCreateCampaign: (newCampaign: Partial<Campaign>) => void;
}

export const AdvertiserStudio: React.FC<AdvertiserStudioProps> = ({
  campaigns,
  currency,
  currentUser,
  onCreateCampaign,
}) => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [businessName, setBusinessName] = useState('Kigali Craft Coffee Co.');
  const [campaignName, setCampaignName] = useState('');
  const [adFormat, setAdFormat] = useState<AdFormat>('PRE_ROLL');
  const [budgetRwf, setBudgetRwf] = useState('500000');
  const [cpmRateRwf, setCpmRateRwf] = useState('6500');
  const [targetCountry, setTargetCountry] = useState('RW');
  const [targetCategory, setTargetCategory] = useState('All Categories');
  const [headline, setHeadline] = useState('');
  const [callToAction, setCallToAction] = useState('Learn More');
  const [destinationUrl, setDestinationUrl] = useState('https://kigalicoffee.rw');
  const [isSubmitted, setIsSubmitted] = useState(false);

  const totalSpent = campaigns.reduce((acc, c) => acc + c.spentAmountRwf, 0);
  const totalImpressions = campaigns.reduce((acc, c) => acc + c.impressionsCount, 0);
  const totalClicks = campaigns.reduce((acc, c) => acc + c.clicksCount, 0);

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!campaignName.trim() || !headline.trim()) return;

    onCreateCampaign({
      businessName: businessName.trim(),
      name: campaignName.trim(),
      adFormat,
      status: 'PENDING_REVIEW', // Admin approves local campaigns
      budgetAmountRwf: parseInt(budgetRwf, 10) || 500000,
      spentAmountRwf: 0,
      targetCountry,
      targetCategory,
      cpmRateRwf: parseInt(cpmRateRwf, 10) || 6500,
      adCreativeUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      destinationUrl: destinationUrl.trim(),
      headline: headline.trim(),
      callToAction: callToAction.trim(),
      impressionsCount: 0,
      clicksCount: 0,
      startDate: new Date().toISOString().split('T')[0],
      endDate: '2026-06-30',
    });

    setIsSubmitted(true);
    setTimeout(() => {
      setShowCreateModal(false);
      setIsSubmitted(false);
      setCampaignName('');
      setHeadline('');
    }, 1500);
  };

  return (
    <div className="workspace-page studio-page space-y-6">
      {/* Header */}
      <div className="workspace-hero">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-blue-50 dark:bg-blue-950/50 flex items-center justify-center text-blue-600">
            <Megaphone className="w-6 h-6" />
          </div>
          <div>
            <h1 className="workspace-title">
              Advertiser Studio
            </h1>
            <p className="text-xs text-slate-500 font-mono">
              Create and review local advertising campaigns
            </p>
          </div>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="workspace-primary"
        >
          <Plus className="w-4 h-4" />
          <span>Create New Campaign</span>
        </button>
      </div>

      <p className="workspace-preview">Preview workspace · Financial and account activity shown here uses sample data.</p>

      {/* KPI Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-slate-500 text-xs">
            <span>Active Campaigns</span>
            <Target className="w-4 h-4 text-blue-500" />
          </div>
          <div className="text-2xl font-bold font-display text-slate-900 dark:text-white">
            {campaigns.filter((c) => c.status === 'ACTIVE').length}
          </div>
          <div className="text-[11px] text-slate-500">
            {campaigns.length} total campaigns created
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-slate-500 text-xs">
            <span>Delivered Impressions</span>
            <BarChart2 className="w-4 h-4 text-amber-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white tabular-nums">
            {totalImpressions.toLocaleString()}
          </div>
          <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
            Verified viewer completions
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-slate-500 text-xs">
            <span>Total Ad Spend</span>
            <DollarSign className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white tabular-nums">
            {formatCurrency(totalSpent, currency)}
          </div>
          <div className="text-[11px] text-slate-500">
            60% disbursed to creators
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-slate-500 text-xs">
            <span>Average CTR</span>
            <TrendingUp className="w-4 h-4 text-purple-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white tabular-nums">
            {totalImpressions > 0 ? `${((totalClicks / totalImpressions) * 100).toFixed(2)}%` : '0.00%'}
          </div>
          <div className="text-[11px] text-slate-500">
            {totalClicks.toLocaleString()} website visits
          </div>
        </div>
      </div>

      {/* Campaigns Table */}
      <div className="space-y-3">
        <h3 className="font-display font-bold text-sm text-slate-900 dark:text-white">
          Your Advertising Campaigns
        </h3>

        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 border-b border-slate-200 dark:border-slate-800 font-medium">
                <tr>
                  <th className="py-3 px-4">Campaign Name</th>
                  <th className="py-3 px-4">Format</th>
                  <th className="py-3 px-4">Targeting</th>
                  <th className="py-3 px-4 text-right">Budget</th>
                  <th className="py-3 px-4 text-right">Spent</th>
                  <th className="py-3 px-4 text-right">Impressions</th>
                  <th className="py-3 px-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {campaigns.map((camp) => (
                  <tr key={camp.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {camp.name}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono">
                        {camp.businessName} · CPM {formatCurrency(camp.cpmRateRwf, currency)}
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                        {camp.adFormat === 'PRE_ROLL' ? 'Pre-Roll (15s)' : 'Display Banner'}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 font-mono text-[11px] text-slate-600 dark:text-slate-300">
                      {camp.targetCountry} ({camp.targetCategory})
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-900 dark:text-white font-medium">
                      {formatCurrency(camp.budgetAmountRwf, currency)}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-500">
                      {formatCurrency(camp.spentAmountRwf, currency)}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-900 dark:text-white">
                      {camp.impressionsCount.toLocaleString()}
                    </td>
                    <td className="py-3.5 px-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                          camp.status === 'ACTIVE'
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                            : camp.status === 'PENDING_REVIEW'
                            ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400'
                            : 'bg-slate-100 text-slate-600 dark:bg-slate-800'
                        }`}
                      >
                        {camp.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* CREATE CAMPAIGN MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <h3 className="font-display font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
                <Megaphone className="w-4 h-4 text-blue-600" />
                <span>Launch Local Advertisement</span>
              </h3>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            {isSubmitted ? (
              <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 text-xs flex items-center gap-2">
                <Check className="w-4 h-4" />
                <span>Campaign submitted! Sent to Free Me Admin Desk in Kigali for verification.</span>
              </div>
            ) : (
              <form onSubmit={handleFormSubmit} className="space-y-3.5 text-xs">
                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Registered Business Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Campaign Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                    placeholder="e.g. Q1 Specialty Roast Discovery Promo"
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Ad Format *
                    </label>
                    <select
                      value={adFormat}
                      onChange={(e) => setAdFormat(e.target.value as any)}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none"
                    >
                      <option value="PRE_ROLL">Pre-Roll Video (15s)</option>
                      <option value="BANNER_DISPLAY">Display Banner Card</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Target Audience *
                    </label>
                    <select
                      value={targetCountry}
                      onChange={(e) => setTargetCountry(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none"
                    >
                      <option value="RW">Rwanda (Kigali & Provinces)</option>
                      <option value="KE">Kenya (Nairobi)</option>
                      <option value="UG">Uganda (Kampala)</option>
                      <option value="ALL">East Africa Region</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Total Budget (RWF) *
                    </label>
                    <input
                      type="number"
                      step={50000}
                      value={budgetRwf}
                      onChange={(e) => setBudgetRwf(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-white focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Target CPM Rate (RWF) *
                    </label>
                    <input
                      type="number"
                      step={500}
                      value={cpmRateRwf}
                      onChange={(e) => setCpmRateRwf(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-white focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Ad Headline *
                  </label>
                  <input
                    type="text"
                    required
                    value={headline}
                    onChange={(e) => setHeadline(e.target.value)}
                    placeholder="e.g. Freshly roasted Bourbon beans delivered to your doorstep"
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Call to Action Text
                    </label>
                    <input
                      type="text"
                      value={callToAction}
                      onChange={(e) => setCallToAction(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Destination Website URL
                    </label>
                    <input
                      type="url"
                      value={destinationUrl}
                      onChange={(e) => setDestinationUrl(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none"
                    />
                  </div>
                </div>

                {/* Creator Economic Impact Notice */}
                <div className="p-3 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/40 text-[11px] text-blue-800 dark:text-blue-300">
                  <span className="font-semibold">Local Economic Impact:</span> 60% of your {formatCurrency(parseInt(budgetRwf, 10) || 0, currency)} budget will be automatically credited to Rwandan and African digital creators.
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="px-4 py-2 text-slate-500 hover:text-slate-700 font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm transition-colors"
                  >
                    Submit for Review
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
