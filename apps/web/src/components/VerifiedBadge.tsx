import { useId } from 'react';

/**
 * The Free Me verified badge: a twelve-point seal in the brand's teal with a gold edge and a bold tick. Shown next to
 * the names of Premium members' Spaces (and of Spaces verified by Free Me).
 */
export function VerifiedBadge({ size = 16, className = '', label = 'Verified' }: { size?: number; className?: string; label?: string }) {
  const id = useId().replace(/:/g, '');
  // Twelve rounded points around the centre.
  const pts = Array.from({ length: 24 }, (_, i) => { const a = (Math.PI * i) / 12 - Math.PI / 2; const r = i % 2 ? 9.1 : 11; return `${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`; }).join(' ');
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label} className={`inline-block shrink-0 align-[-0.15em] ${className}`}>
      <title>{label}</title>
      <defs>
        <linearGradient id={`fmv-${id}`} x1="3" y1="2" x2="21" y2="22" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#2bc4b8" /><stop offset="1" stopColor="#0a6b67" /></linearGradient>
        <linearGradient id={`fmg-${id}`} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#ffd88a" /><stop offset="1" stopColor="#e39a2a" /></linearGradient>
      </defs>
      <polygon points={pts} fill={`url(#fmv-${id})`} stroke={`url(#fmg-${id})`} strokeWidth="1.1" strokeLinejoin="round" />
      <path d="m7.6 12.3 3 3 5.8-6" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
