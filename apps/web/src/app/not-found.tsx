import { SearchX } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/EmptyState';

export default function NotFound() {
  return (
    <EmptyState icon={<SearchX size={36} strokeWidth={1.4} />} title="This page isn't available"
      action={<Link href="/" className="inline-flex h-10 items-center rounded-full bg-strong px-5 text-[14px] font-medium text-on-strong">Go to Home</Link>}>
      The link may be broken, or the page may have been removed.
    </EmptyState>
  );
}
