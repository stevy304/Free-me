import type { ReactNode } from 'react';

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center">
      <div className="mb-5 grid h-20 w-20 place-items-center rounded-full bg-surface text-muted">{icon}</div>
      <h2 className="text-xl font-semibold">{title}</h2>
      {children && <div className="mt-2 text-[15px] leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
