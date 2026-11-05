/** A rounded-square picture (Free Me's avatar shape), or the first letter on a colour that stays the same for the same name. */
const HUES = [172, 200, 262, 330, 20, 40, 140, 220];

export function Avatar({ name, src, size = 36, className = '' }: { name: string; src?: string | null; size?: number; className?: string }) {
  const style = { width: size, height: size };
  if (src) return <img src={src} alt="" width={size} height={size} referrerPolicy="no-referrer" className={`shrink-0 object-cover ${className}`} style={{ ...style, borderRadius: '30%' }} />;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center font-display font-bold text-white ${className}`}
      style={{ ...style, borderRadius: '30%', fontSize: Math.round(size * 0.44), background: `hsl(${HUES[h % HUES.length]} 55% 42%)` }}>
      {[...name.trim()][0]?.toUpperCase() ?? '?'}
    </span>
  );
}
