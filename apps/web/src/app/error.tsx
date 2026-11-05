'use client';

import { CloudOff } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <EmptyState icon={<CloudOff size={36} strokeWidth={1.4} />} title="Something went wrong"
      action={<button type="button" onClick={reset} className="inline-flex h-10 items-center rounded-full bg-strong px-5 text-[14px] font-medium text-on-strong">Try again</button>}>
      We could not load this page. Check your connection and try again.
    </EmptyState>
  );
}
