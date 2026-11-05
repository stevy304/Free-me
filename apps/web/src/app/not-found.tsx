import * as Icon from '@/components/icons';
import Link from 'next/link';
import { EmptyState } from '@/components/EmptyState';

export default function NotFound() {
  return (
    <EmptyState icon={<Icon.SearchEmpty size={36} strokeWidth={1.4} />} title="This page isn't available"
      action={<Link href="/" className="inline-flex h-10 items-center rounded-xl bg-brand px-5 text-[14px] font-semibold text-on-brand">Go to Home</Link>}>
      The link may be broken, or the page may have been removed.
    </EmptyState>
  );
}
