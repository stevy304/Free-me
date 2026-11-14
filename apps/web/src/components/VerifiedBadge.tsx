import { useId } from 'react';

/**
 * Free Me badges, a twelve-point seal. `verified` (teal, white tick): Free Me checked who runs this Space.
 * `premium` (gold, white star): the Space's owner is a Premium member. They are drawn differently so a badge that
 * can be bought is never mistaken for a checked identity.
 */
export function VerifiedBadge({ size = 16, className = '', kind = 'verified', label }: { size?: number; className?: string; kind?: 'verified' | 'premium' | null; label?: string }) {
  const premium = kind === 'premium';
  label ??= premium ? 'Premium member' : 'Verified by Free Me';
  const id = useId().replace(/:/g, '');
  // Twelve rounded points around the centre.
  const pts = Array.from({ length: 24 }, (_, i) => { const a = (Math.PI * i) / 12 - Math.PI / 2; const r = i % 2 ? 9.1 : 11; return `${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`; }).join(' ');
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label} className={`inline-block shrink-0 align-[-0.15em] ${className}`}>
      <title>{label}</title>
      <defs>
        <linearGradient id={`fmv-${id}`} x1="3" y1="2" x2="21" y2="22" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#2bc4b8" /><stop offset="1" stopColor="#0a6b67" /></linearGradient>
        <linearGradient id={`fmg-${id}`} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#ffd88a" /><stop offset="1" stopColor="#d9962e" /></linearGradient>
      </defs>
      <polygon points={pts} fill={premium ? `url(#fmg-${id})` : `url(#fmv-${id})`} stroke={premium ? `url(#fmv-${id})` : `url(#fmg-${id})`} strokeWidth="1.1" strokeLinejoin="round" />
      {premium
        ? <path d="m12 6.6 1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z" fill="#fff" />
        : <path d="m7.6 12.3 3 3 5.8-6" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}
