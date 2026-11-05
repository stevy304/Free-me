import Link from 'next/link';
import type { Category } from '@/lib/types';

/** Category chips under the top bar ("All" plus each category), scrollable sideways. */
export function ChipBar({ categories, active }: { categories: Category[]; active: string | null }) {
  const chip = (on: boolean) => `shrink-0 rounded-lg px-3 py-1.5 text-[14px] font-medium whitespace-nowrap ${on ? 'bg-strong text-on-strong' : 'bg-surface hover:bg-surface-hover'}`;
  return (
    <div className="sticky top-14 z-10 -mx-4 bg-bg px-4 py-3 sm:-mx-6 sm:px-6">
      <div className="no-scrollbar flex gap-3 overflow-x-auto">
        <Link href="/" className={chip(!active)} aria-current={!active ? 'page' : undefined}>All</Link>
        {categories.map((c) => <Link key={c.id} href={`/?category=${c.slug}`} className={chip(active === c.slug)} aria-current={active === c.slug ? 'page' : undefined}>{c.name}</Link>)}
      </div>
    </div>
  );
}
