import Link from 'next/link';
import type { ReactNode } from 'react';
import * as Icon from '@/components/icons';

const PAGES = [
  ['/legal/terms', 'Terms of Service'],
  ['/legal/privacy', 'Privacy Policy'],
  ['/legal/guidelines', 'Community Guidelines'],
  ['/legal/copyright', 'Copyright'],
] as const;

/** Shared layout for the legal pages: title, date, contents on the side, readable measure. */
export function LegalPage({ path, title, updated, intro, sections }: { path: string; title: string; updated: string; intro: ReactNode; sections: Array<{ id: string; title: string; body: ReactNode }> }) {
  return (
    <div className="mx-auto flex max-w-[1100px] gap-10 px-4 py-8 sm:px-6">
      <nav aria-label="Legal pages" className="sticky top-20 hidden h-fit w-56 shrink-0 lg:block">
        <p className="mb-2 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-muted"><Icon.Scale size={16} />Policies</p>
        <ul className="space-y-0.5 text-[14px]">{PAGES.map(([href, label]) => <li key={href}><Link href={href} aria-current={href === path ? 'page' : undefined} className={`block rounded-lg px-3 py-2 ${href === path ? 'bg-surface font-semibold' : 'hover:bg-surface'}`}>{label}</Link></li>)}</ul>
        <p className="mb-2 mt-6 text-[13px] font-semibold uppercase tracking-wide text-muted">On this page</p>
        <ul className="space-y-1 text-[13px] text-muted">{sections.map((s) => <li key={s.id}><a href={`#${s.id}`} className="hover:text-ink">{s.title}</a></li>)}</ul>
      </nav>
      <article className="min-w-0 max-w-[720px] flex-1 text-[15px] leading-7">
        <h1 className="text-[32px] font-bold leading-10">{title}</h1>
        <p className="mt-1 text-[13px] text-muted">Last updated {updated}</p>
        <div className="mt-5 space-y-3">{intro}</div>
        {sections.map((s, i) => (
          <section key={s.id} id={s.id} className="scroll-mt-20">
            <h2 className="mb-2 mt-8 text-[20px] font-semibold">{i + 1}. {s.title}</h2>
            <div className="space-y-3 [&_li]:ml-5 [&_li]:list-disc [&_a]:text-brand [&_a]:underline-offset-2 hover:[&_a]:underline">{s.body}</div>
          </section>
        ))}
      </article>
    </div>
  );
}

/** "write to ... " sentence built only from configured contact details. */
export function Contact({ email, address, fallback }: { email: string | null; address?: string | null; fallback: ReactNode }) {
  if (!email && !address) return <>{fallback}</>;
  return <>{email && <>by email to <a href={`mailto:${email}`}>{email}</a></>}{email && address && ' or '}{address && <>by post to {address}</>}</>;
}
