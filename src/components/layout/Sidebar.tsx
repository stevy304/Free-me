import React from 'react';
import {
  Home,
  Flame,
  Tv,
  Compass,
  History,
  ThumbsUp,
  LayoutDashboard,
  Megaphone,
  ShieldAlert,
  Sparkles,
  Music,
  Cpu,
  TreePine,
  Coffee,
  Info,
} from 'lucide-react';
import { User } from '../../types';

interface SidebarProps {
  currentView: string;
  onNavigate: (view: string, param?: string) => void;
  selectedCategory: string;
  onSelectCategory: (category: string) => void;
  currentUser: User;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onNavigate,
  selectedCategory,
  onSelectCategory,
  currentUser,
}) => {
  const categories = [
    { name: 'All Categories', icon: Compass },
    { name: 'Kigali Life', icon: Sparkles },
    { name: 'Tech & Innovation', icon: Cpu },
    { name: 'Wildlife & Safari', icon: TreePine },
    { name: 'Music & Performance', icon: Music },
    { name: 'Culinary & Coffee', icon: Coffee },
  ];

  return (
    <aside className="w-64 shrink-0 hidden md:flex flex-col justify-between h-[calc(100vh-4rem)] sticky top-16 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 overflow-y-auto p-3 text-sm">
      <div className="space-y-6">
        {/* Primary Navigation */}
        <div className="space-y-1">
          <button
            onClick={() => onNavigate('home')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors font-medium text-left ${
              currentView === 'home' && selectedCategory === 'All Categories'
                ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <Home className="w-4 h-4" />
            <span>Home</span>
          </button>

          <button
            onClick={() => onNavigate('shorts')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors font-medium text-left ${
              currentView === 'shorts'
                ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <Flame className="w-4 h-4 text-orange-500" />
            <span>Shorts</span>
          </button>

          <button
            onClick={() => onNavigate('subscriptions')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors font-medium text-left ${
              currentView === 'subscriptions'
                ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <Tv className="w-4 h-4" />
            <span>Subscriptions</span>
          </button>
        </div>

        {/* Studio & Monetization Hub */}
        <div className="space-y-1 pt-3 border-t border-slate-200 dark:border-slate-800">
          <div className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
            African Creator Hub
          </div>

          <button
            onClick={() => onNavigate('studio')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors font-medium text-left ${
              currentView === 'studio'
                ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <LayoutDashboard className="w-4 h-4 text-amber-600" />
            <div className="flex-1 flex items-center justify-between">
              <span>Creator Studio</span>
              <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                60% Split
              </span>
            </div>
          </button>

          <button
            onClick={() => onNavigate('advertiser')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors font-medium text-left ${
              currentView === 'advertiser'
                ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <Megaphone className="w-4 h-4 text-blue-500" />
            <span>Local Ads Manager</span>
          </button>

          {currentUser.role === 'ADMIN' && (
            <button
              onClick={() => onNavigate('admin')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors font-medium text-left ${
                currentView === 'admin'
                  ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <ShieldAlert className="w-4 h-4 text-rose-500" />
              <span>Platform Admin</span>
            </button>
          )}
        </div>

        {/* Explore Categories */}
        <div className="space-y-1 pt-3 border-t border-slate-200 dark:border-slate-800">
          <div className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
            Explore Topics
          </div>
          {categories.map((cat) => {
            const Icon = cat.icon;
            const isSelected = selectedCategory === cat.name && currentView === 'home';
            return (
              <button
                key={cat.name}
                onClick={() => {
                  onSelectCategory(cat.name);
                  onNavigate('home');
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-left ${
                  isSelected
                    ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 font-medium'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Icon className="w-4 h-4 text-slate-400" />
                <span className="truncate">{cat.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Footer Transparency & African Ownership Note */}
      <div className="p-3 mt-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 space-y-1.5">
        <div className="flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-200">
          <Info className="w-3.5 h-3.5 text-amber-600" />
          <span>Transparent Split</span>
        </div>
        <p className="text-[11px] leading-relaxed">
          60% creator pool · 30% operations · 10% community reinvestment fund.
        </p>
        <div className="pt-1 text-[10px] text-slate-400 border-t border-slate-200 dark:border-slate-700/60 flex items-center justify-between">
          <span>Kigali, Rwanda</span>
          <span>v1.0-prod</span>
        </div>
      </div>
    </aside>
  );
};
