import Link from 'next/link';

/** Free Me brand: the original mark and wordmark. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#0c827e" d="M6 13c0-5 4-8 8-6l26 13c4 2 4 7 0 9L13 43c-4 2-7-1-7-5zm10 4v15l16-8z" />
      <path fill="#21a79e" d="M6 13c0-5 4-8 8-6l26 13c3 2 4 4 2 7L11 12c-2-1-4 0-5 1z" />
      <path fill="#075655" d="m16 32 16-8 10 4-28 15c-4 2-7 0-8-4z" />
    </svg>
  );
}

export function Logo() {
  return (
    <Link href="/" aria-label="Free Me home" className="flex items-center gap-1.5 rounded-md px-1 py-1">
      <LogoMark />
      <span className="text-[19px] font-bold tracking-[-0.03em] text-ink">Free <span className="text-brand">Me</span></span>
    </Link>
  );
}
