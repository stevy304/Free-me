import React, { useState } from 'react';
import { Bell, EllipsisVertical, Plus, Search } from 'lucide-react';
import { User } from '../../types';

interface HeaderProps {
  currentUser: User;
  navigationExpanded: boolean;
  onToggleNavigation: () => void;
  recentUploads: string[];
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
  navigationExpanded,
  onToggleNavigation,
  recentUploads,
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
  const [showNotifications, setShowNotifications] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);

  return (
    <header className="discovery-header" onKeyDown={(event) => {
      if (event.key === 'Escape') {
        setShowUserDropdown(false);
        setMobileSearch(false);
        setShowNotifications(false);
      }
    }}>
      <div className="discovery-brand-group">
        <button type="button" id="navigation-toggle" className="discovery-icon-button"
          aria-label="Navigation menu" aria-controls="main-navigation" aria-expanded={navigationExpanded}
          onClick={() => { setMobileSearch(false); onToggleNavigation(); }}><EllipsisVertical size={23} aria-hidden="true" /></button>
        <button className="discovery-brand" onClick={() => onNavigate('home')} aria-label="Free Me home">
          <img src="/free-me.svg" alt="" />
          <span>Free Me</span>
        </button>
      </div>
      <form className={`discovery-search ${mobileSearch ? 'is-open' : ''}`} role="search" onSubmit={(event) => {
        onSearchSubmit(event);
        setMobileSearch(false);
      }}>
        <input type="search" aria-label="Search Free Me" placeholder="Search" value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)} />
        <button type="submit" aria-label="Submit search"><Search size={21} aria-hidden="true" /></button>
      </form>
      <div className="discovery-actions">
        <button className="discovery-search-toggle" aria-label="Toggle search" aria-expanded={mobileSearch}
          onClick={() => setMobileSearch(!mobileSearch)}><Search size={23} /></button>
        <button className="discovery-upload" onClick={onOpenUpload}><Plus size={21} aria-hidden="true" /> Create</button>
        <div className="relative hidden md:block">
          <button aria-label="Notifications" aria-expanded={showNotifications} className="relative"
            onClick={() => { setShowNotifications(!showNotifications); setShowUserDropdown(false); }}>
            <Bell size={23} />
            {recentUploads.length > 0 && <span className="absolute right-0 top-0 h-2 w-2 rounded-full bg-amber-500" />}
          </button>
          {showNotifications && (
            <div className="discovery-account-menu" aria-label="Notifications">
              <strong>Notifications</strong>
              {recentUploads.length ? recentUploads.map((title, index) => <p key={index} className="text-sm">Ready to watch · {title}</p>)
                : <p className="text-sm">No recent uploads.</p>}
            </div>
          )}
        </div>
        <div className="relative">
          <button className="discovery-account" aria-label="Account and settings" aria-expanded={showUserDropdown}
            onClick={() => { setShowUserDropdown(!showUserDropdown); setShowNotifications(false); }}>
            <img src={currentUser.avatarUrl} alt="" referrerPolicy="no-referrer" />
          </button>
          {showUserDropdown && (
            <div className="discovery-account-menu">
              <strong>{currentUser.displayName}</strong>
              <button onClick={() => { setShowUserDropdown(false); onNavigate('account'); }}>Creator account & uploads</button>
              <button className="md:hidden" onClick={() => { setShowUserDropdown(false); onOpenUpload(); }}>Upload video</button>
              <button onClick={onToggleDarkMode}>{darkMode ? 'Light appearance' : 'Dark appearance'}</button>
              <button onClick={onToggleCurrency}>Currency · {currency}</button>
              <button onClick={() => { setShowUserDropdown(false); onNavigate('advertiser'); }}>Advertiser Studio</button>
              {currentUser.role === 'ADMIN' && <button onClick={() => { setShowUserDropdown(false); onNavigate('admin'); }}>Admin Control Center</button>}
              <span className="mt-2 text-xs opacity-70">Preview accounts</span>
              {users.map((user) => (
                <button key={user.id} aria-pressed={user.id === currentUser.id} onClick={() => {
                  onSelectUser(user);
                  setShowUserDropdown(false);
                }}>{user.displayName} · {user.role.toLowerCase()}</button>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
