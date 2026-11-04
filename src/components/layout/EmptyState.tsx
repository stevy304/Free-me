import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({ icon: Icon, title, description, children }: {
  icon: LucideIcon;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="app-empty" role="status">
      <span className="app-empty-icon"><Icon size={23} aria-hidden="true" /></span>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  );
}
