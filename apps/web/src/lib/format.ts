/** Number and date formatting in the reader's language, for any country. */

export function compactNumber(n: number | string, locale?: string): string {
  const v = typeof n === 'string' ? Number(n) : n;
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(Number.isFinite(v) ? v : 0);
}

export function viewsLabel(n: number | string, locale?: string): string {
  const v = Number(n);
  return `${compactNumber(v, locale)} ${v === 1 ? 'view' : 'views'}`;
}

export function followersLabel(n: number, locale?: string): string {
  return `${compactNumber(n, locale)} ${n === 1 ? 'follower' : 'followers'}`;
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60], ['second', 1]];
/** "3 days ago". In English, like the rest of the interface, until the interface is translated. */
export function timeAgo(iso: string | null, _locale?: string): string {
  if (!iso) return '';
  const sec = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, s] of UNITS) if (Math.abs(sec) >= s || unit === 'second') return rtf.format(Math.round(sec / s), unit);
  return '';
}

export function duration(total: number): string {
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = Math.floor(total % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fullDate(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}
