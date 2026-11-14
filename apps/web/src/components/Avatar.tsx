'use client';

import { useState } from 'react';

/**
 * A person's or Space's picture, round; or the first letter on a colour that stays the same for the same name.
 * `facet`: the cut-corner square of a Space's own page.
 */
// Warm and cool hues that sit well on clay and kaolin.
const HUES = [172, 200, 262, 330, 18, 38, 140, 220];

export function Avatar({ name, src, size = 36, className = '', facet = false }: { name: string; src?: string | null; size?: number; className?: string; facet?: boolean }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  const shape = facet ? `facet ${className}` : className;
  const radius = facet ? '0' : '50%';
  // A picture that cannot load (offline, removed) shows the first letter instead of a broken image.
  if (src && !failed) return <img src={src} alt="" onError={() => setFailed(true)} width={size} height={size} referrerPolicy="no-referrer" className={`shrink-0 object-cover ${shape}`} style={{ ...style, borderRadius: radius }} />;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center font-display font-bold text-white ${shape}`}
      style={{ ...style, borderRadius: radius, fontSize: Math.round(size * 0.44), background: `hsl(${HUES[h % HUES.length]} 55% 42%)` }}>
      {[...name.trim()][0]?.toUpperCase() ?? '?'}
    </span>
  );
}

