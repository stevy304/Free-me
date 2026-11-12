import { langOf, rwAgo, translator } from '@/i18n';
/** Number and date formatting in the reader's language, for any country. */

export function compactNumber(n: number | string, locale?: string): string {
  const v = typeof n === 'string' ? Number(n) : n;
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(Number.isFinite(v) ? v : 0);
}

export function viewsLabel(n: number | string, locale?: string): string {
  const v = Number(n);
  return translator(langOf(locale))(v === 1 ? 'video.views.one' : 'video.views.other', { count: compactNumber(v, locale) });
}

/** "4.8K tuned in": how many people tune in to a Space. A Space nobody has tuned in to yet says "New Space", not "0". */
export function followersLabel(n: number, locale?: string): string {
  const t = translator(langOf(locale));
  if (!n) return t('space.new');
  return t('space.followers', { count: compactNumber(n, locale) });
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60], ['second', 1]];
/** "3 days ago" in the interface language (Kinyarwanda by hand: the browser's own gives only "-3 d"). */
export function timeAgo(iso: string | null, locale?: string): string {
  if (!iso) return '';
  const sec = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const lang = langOf(locale);
  if (Math.abs(sec) < 45) return translator(lang)('time.justNow');
  const rtf = lang === 'rw' ? null : new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  for (const [unit, s] of UNITS) {
    if (Math.abs(sec) >= s || unit === 'second') { const v = Math.round(sec / s); return rtf ? rtf.format(v, unit) : rwAgo(v, unit); }
  }
  return '';
}

export function duration(total: number): string {
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = Math.floor(total % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fullDate(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}
