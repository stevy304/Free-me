/**
 * Free Me is worldwide: countries are ISO 3166-1 alpha-2 codes, languages BCP 47 tags, currencies ISO 4217 codes.
 * Names come from the runtime's Intl data in the reader's own language, so nothing here is tied to one market.
 */

/** Every assigned ISO 3166-1 alpha-2 code. */
export const COUNTRY_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO ' +
  'JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR ' +
  'MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO ' +
  'RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV ' +
  'TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');
const COUNTRY_SET = new Set(COUNTRY_CODES);

export function isCountryCode(v: unknown): boolean {
  return typeof v === 'string' && COUNTRY_SET.has(v.toUpperCase());
}

/** Languages people can choose for the interface and for their content (BCP 47). */
export const LANGUAGE_CODES = [
  'en', 'fr', 'es', 'pt', 'ar', 'zh', 'hi', 'bn', 'ru', 'ja', 'de', 'ko', 'it', 'tr', 'vi', 'id', 'ms', 'th', 'fa', 'ur',
  'pl', 'uk', 'nl', 'sv', 'ro', 'el', 'cs', 'hu', 'he', 'fil', 'sw', 'rw', 'rn', 'lg', 'am', 'so', 'ha', 'yo', 'ig', 'zu',
  'xh', 'af', 'ln', 'wo', 'om', 'ti', 'mg', 'ny', 'sn', 'ta', 'te', 'mr', 'gu', 'pa', 'ne', 'si', 'my', 'km', 'lo',
] as const;
const LANGUAGE_SET = new Set<string>(LANGUAGE_CODES);

export function isLanguageCode(v: unknown): boolean {
  return typeof v === 'string' && LANGUAGE_SET.has(v.toLowerCase());
}

/** A country's name in the given display language ("RW" → "Rwanda", or "Ruanda" in Spanish). */
export function countryName(code: string, locale = 'en'): string {
  try { return new Intl.DisplayNames([locale], { type: 'region' }).of(code.toUpperCase()) ?? code; } catch { return code; }
}

/** A language's own name ("fr" → "français"), used in language pickers. */
export function languageName(code: string, locale?: string): string {
  try { return new Intl.DisplayNames([locale ?? code], { type: 'language' }).of(code) ?? code; } catch { return code; }
}

/** Digits after the decimal point for a currency (RWF 0, USD 2, KWD 3). */
export function currencyMinorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    throw new Error(`Unknown currency "${currency}".`);
  }
}
