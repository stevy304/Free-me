import { BarChart3, Compass, House, TvMinimalPlay, Zap } from 'lucide-react';

const destinations = [
  { id: 'home', label: 'Home', icon: House },
  { id: 'explore', label: 'Explore', icon: Compass },
  { id: 'shorts', label: 'Shorts', icon: Zap },
  { id: 'subscriptions', label: 'Subscriptions', icon: TvMinimalPlay },
  { id: 'studio', label: 'Creator Studio', mobileLabel: 'Studio', icon: BarChart3 },
];

export function Sidebar({ currentView, expanded, onNavigate }: {
  currentView: string;
  expanded: boolean;
  onNavigate: (view: string) => void;
}) {
  return (
    <nav id="main-navigation" aria-label="Main navigation" className={`discovery-nav ${expanded ? 'is-expanded' : ''}`}>
      {destinations.map(({ id, label, mobileLabel, icon: Icon }) => (
        <button key={id} type="button" aria-current={currentView === id ? 'page' : undefined}
          onClick={() => onNavigate(id)}>
          <Icon aria-hidden="true" size={21} />
          <span className={mobileLabel ? 'nav-long-label' : undefined}>{label}</span>
          {mobileLabel && <span className="nav-short-label">{mobileLabel}</span>}
        </button>
      ))}
    </nav>
  );
}
