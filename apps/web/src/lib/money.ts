/** Money shown to people. Amounts arrive as minor units (cents; whole francs for RWF). */
const digits = (currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;

export function money(minor: number | string, currency: string, locale = 'en') {
  const n = Number(minor) / 10 ** digits(currency);
  return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: currency === 'RWF' ? 'code' : 'symbol', minimumFractionDigits: n % 1 ? digits(currency) : 0, maximumFractionDigits: digits(currency) }).format(n);
}

export const usd = (cents: number, locale = 'en') => money(cents, 'USD', locale);

/**
 * The charge in a payment method's currency for a dollar price, rounded like the API: whole units, and amounts of
 * 1,000 or more in a currency without cents to the nearest 100 (RWF 2,494 → 2,500).
 */
export const charge = (usdCents: number, m: { currency: string; perUsd: number }) => {
  if (m.currency === 'USD') return usdCents;
  const d = digits(m.currency);
  const exact = (usdCents / 100) * m.perUsd;
  return (d === 0 && exact >= 1000 ? Math.round(exact / 100) * 100 : Math.ceil(exact)) * 10 ** d;
};
