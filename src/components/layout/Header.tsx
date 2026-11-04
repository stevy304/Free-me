import React, { useState } from 'react';
import {
  Search,
  Upload,
  Sun,
  Moon,
  Coins,
  ShieldCheck,
  Briefcase,
  Video,
  User as UserIcon,
  Check,
  X,
} from 'lucide-react';
import { User, Role } from '../../types';

interface HeaderProps {
  currentUser: User;
  users: User[];
  onSelectUser: (user: User) => void;
  currency: 'RWF' | 'USD';
  onToggleCurrency: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onOpenUpload: () => void;
  onNavigate: (view: string, param?: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSearchSubmit: (e: React.FormEvent) => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentUser,
  users,
  onSelectUser,
  currency,
  onToggleCurrency,
  darkMode,
  onToggleDarkMode,
  onOpenUpload,
  onNavigate,
  searchQuery,
  onSearchChange,
  onSearchSubmit,
}) => {
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [showSearchSuggestions, setShowSearchSuggestions] = useState(false);

  const suggestions = [
    'Kigali architecture & art',
    'Rwanda fintech and startups',
    'Mountain Gorillas 4K Volcanoes',
    'East African Afrobeats live',
    'Bourbon coffee washing station',
    'Autonomous delivery drones',
  ].filter((s) => s.toLowerCase().includes(searchQuery.toLowerCase()) && searchQuery.trim().length > 0);

  return (
    <header className="sticky top-0 z-40 flex items-center justify-between gap-6 px-4 md:px-6 h-16 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 transition-colors">
      {/* Zone 1: Brand Wordmark */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          onClick={() => onNavigate('home')}
          className="flex items-center gap-2.5 text-left focus:outline-none group"
        >
          <div className="w-9 h-9 rounded-lg bg-amber-600 flex items-center justify-center text-white font-bold tracking-wider shadow-sm group-hover:bg-amber-500 transition-colors">
            <span className="font-display text-lg">FM</span>
          </div>
          <div>
            <span className="font-display font-extrabold text-xl tracking-tight text-slate-900 dark:text-white flex items-center gap-1.5">
              Free Me
              <span className="text-[10px] font-mono uppercase tracking-widest text-amber-600 dark:text-amber-400 font-semibold px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/60 border border-amber-200 dark:border-amber-800/50">
                RW
              </span>
            </span>
          </div>
        </button>
      </div>

      {/* Zone 2: Navigation Links & Search Bar */}
      <div className="flex-1 max-w-2xl mx-auto flex items-center gap-4">
        <form onSubmit={onSearchSubmit} className="relative w-full">
          <div className="relative flex items-center">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                onSearchChange(e.target.value);
                setShowSearchSuggestions(true);
              }}
              onFocus={() => setShowSearchSuggestions(true)}
              placeholder="Search African creators, videos, music, tech..."
              className="w-full pl-10 pr-10 py-2 text-sm bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-lg border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500/50 transition-all placeholder:text-slate-400"
            />
            <Search className="absolute left-3 w-4 h-4 text-slate-400 pointer-events-none" />
            {searchQuery && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                className="absolute right-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Autocomplete suggestions */}
          {showSearchSuggestions && suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-lg overflow-hidden z-50">
              {suggestions.map((item, idx) => (
                <button
                  key={idx}
                  type="button"
                  onMouseDown={() => {
                    onSearchChange(item);
                    setShowSearchSuggestions(false);
                  }}
                  className="w-full text-left px-4 py-2 text-xs md:text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 flex items-center gap-2"
                >
                  <Search className="w-3.5 h-3.5 text-slate-400" />
                  <span>{item}</span>
                </button>
              ))}
            </div>
          )}
        </form>

        <nav className="hidden lg:flex items-center gap-5 text-sm font-medium text-slate-600 dark:text-slate-300">
          <button
            onClick={() => onNavigate('home')}
            className="hover:text-amber-600 dark:hover:text-amber-400 transition-colors whitespace-nowrap shrink-0"
          >
            Home
          </button>
          <button
            onClick={() => onNavigate('shorts')}
            className="hover:text-amber-600 dark:hover:text-amber-400 transition-colors whitespace-nowrap shrink-0"
          >
            Shorts
          </button>
          <button
            onClick={() => onNavigate('studio')}
            className="hover:text-amber-600 dark:hover:text-amber-400 transition-colors whitespace-nowrap shrink-0"
          >
            Studio
          </button>
          <button
            onClick={() => onNavigate('advertiser')}
            className="hover:text-amber-600 dark:hover:text-amber-400 transition-colors whitespace-nowrap shrink-0"
          >
            Ads
          </button>
        </nav>
      </div>

      {/* Zone 3: Actions & Account Switcher */}
      <div className="flex items-center gap-2 md:gap-3 shrink-0">
        {/* Currency Switcher (RWF / USD) */}
        <button
          onClick={onToggleCurrency}
          title={`Active currency: ${currency}. Click to switch.`}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-mono font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
        >
          <Coins className="w-3.5 h-3.5 text-amber-500" />
          <span>{currency}</span>
        </button>

        {/* Dark/Light mode toggle */}
        <button
          onClick={onToggleDarkMode}
          title="Toggle theme"
          className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
        >
          {darkMode ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-600" />}
        </button>

        {/* Upload Button */}
        <button
          onClick={onOpenUpload}
          className="hidden sm:flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-500 rounded-lg shadow-sm transition-colors whitespace-nowrap shrink-0"
        >
          <Upload className="w-3.5 h-3.5" />
          <span>Upload</span>
        </button>

        {/* Role & Persona Switcher */}
        <div className="relative">
          <button
            onClick={() => setShowUserDropdown(!showUserDropdown)}
            className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <img
              src={currentUser.avatarUrl}
              alt={currentUser.displayName}
              referrerPolicy="no-referrer"
              className="w-8 h-8 rounded-full object-cover border border-slate-300 dark:border-slate-700"
            />
            <span className="hidden xl:inline text-xs font-medium text-slate-800 dark:text-slate-200 max-w-[120px] truncate">
              {currentUser.displayName}
            </span>
          </button>

          {showUserDropdown && (
            <div className="absolute right-0 top-full mt-2 w-72 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-xl py-2 z-50">
              <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-700/60">
                <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  {currentUser.displayName}
                </p>
                <p className="text-[11px] text-slate-500 truncate">{currentUser.email}</p>
                <div className="mt-1 flex items-center gap-1.5 text-[10px] font-mono uppercase text-amber-600 dark:text-amber-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                  Role: {currentUser.role}
                </div>
              </div>

              <div className="px-2 py-1">
                <p className="px-2 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Switch Persona / Role
                </p>
                {users.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => {
                      onSelectUser(u);
                      setShowUserDropdown(false);
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors ${
                      currentUser.id === u.id
                        ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 font-medium'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <img
                        src={u.avatarUrl}
                        alt={u.displayName}
                        referrerPolicy="no-referrer"
                        className="w-6 h-6 rounded-full object-cover"
                      />
                      <div className="text-left">
                        <div className="leading-tight">{u.displayName}</div>
                        <div className="text-[10px] text-slate-400 font-mono">
                          {u.role === 'CREATOR'
                            ? 'Creator Studio'
                            : u.role === 'ADVERTISER'
                            ? 'Local Advertiser'
                            : u.role === 'ADMIN'
                            ? 'Platform Admin'
                            : 'Standard Viewer'}
                        </div>
                      </div>
                    </div>
                    {currentUser.id === u.id && <Check className="w-3.5 h-3.5 text-amber-600" />}
                  </button>
                ))}
              </div>

              <div className="border-t border-slate-100 dark:border-slate-700/60 pt-1 mt-1 px-2">
                <button
                  onClick={() => {
                    onNavigate('admin');
                    setShowUserDropdown(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center gap-2"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-slate-400" />
                  <span>Admin Control Center</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
