'use client';

import * as Icon from '@/components/icons';
import { EmptyState } from '@/components/EmptyState';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <EmptyState icon={<Icon.Offline size={36} strokeWidth={1.4} />} title="Something went wrong"
      action={<button type="button" onClick={reset} className="inline-flex h-10 items-center rounded-xl bg-brand px-5 text-[14px] font-semibold text-on-brand">Try again</button>}>
      We could not load this page. Check your connection and try again.
    </EmptyState>
  );
}
