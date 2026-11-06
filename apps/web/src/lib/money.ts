/** Money shown to people. Amounts arrive as minor units (cents; whole francs for RWF). */
const digits = (currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;

export function money(minor: number | string, currency: string, locale = 'en') {
  const n = Number(minor) / 10 ** digits(currency);
  return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: currency === 'RWF' ? 'code' : 'symbol', minimumFractionDigits: n % 1 ? digits(currency) : 0, maximumFractionDigits: digits(currency) }).format(n);
}

export const usd = (cents: number, locale = 'en') => money(cents, 'USD', locale);

/** The charge in a payment method's currency for a dollar price (MoMo rounds up to a whole unit, like the API). */
export const charge = (usdCents: number, m: { currency: string; perUsd: number }) =>
  m.currency === 'USD' ? usdCents : Math.ceil((usdCents / 100) * m.perUsd) * 10 ** digits(m.currency);
