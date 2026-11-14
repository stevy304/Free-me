import Link from 'next/link';

/**
 * Free Me brand (BRAND.md): nested Imigongo diamonds, open on one side (a frame that lets you out), with a Kivu-teal
 * core. The outer line takes the text colour, so the mark reads on light and dark; the clay and teal never change.
 */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
      <g fill="none" strokeWidth="5.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M33 13 24 4 4 24l20 20 9-9" stroke="currentColor" />
        <path d="M29.5 19.5 24 14 14 24l10 10 5.5-5.5" stroke="#d65f36" />
        <path d="M38 24h6" stroke="#22ada2" />
      </g>
      <path d="M24 19.6 28.4 24 24 28.4 19.6 24z" fill="#22ada2" />
    </svg>
  );
}

/** The wordmark: "free◆me" in the display face, the diamond in clay. */
export function Wordmark({ className = 'text-[22px]' }: { className?: string }) {
  return (
    <span className={`font-display font-extrabold tracking-[-0.05em] text-ink ${className}`}>
      free<span aria-hidden="true" className="mx-[0.03em] inline-block align-[0.12em] text-[0.6em] text-clay">◆</span>me
    </span>
  );
}

export function Logo() {
  return (
    <Link href="/" aria-label="Free Me home" className="flex shrink-0 items-center gap-2 rounded-lg px-1 py-1 text-ink">
      <LogoMark size={30} />
      <Wordmark className="hidden text-[22px] min-[400px]:inline" />
    </Link>
  );
}
