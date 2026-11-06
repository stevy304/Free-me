import { readFileSync } from 'node:fs';

/**
 * Sign-in codes from the API log (MAIL_TRANSPORT=console). Accounts such as admin@example.com sign in more than once
 * in a run, so the code must be one sent after `sent()` was called, never an earlier one still in the log.
 */
const LOG = process.env.E2E_API_LOG ?? '';
const pattern = (email: string) => new RegExp(`to ${email.replace(/[.+]/g, '\\$&')}: (\\d{6})`, 'g');
const all = (email: string) => (LOG ? [...readFileSync(LOG, 'utf8').matchAll(pattern(email))].map((m) => m[1]) : []);

/** Call before asking for a code; then `await next()` returns the new one. */
export function expectCode(email: string) {
  const before = all(email).length;
  return async () => {
    for (let i = 0; i < 80; i++) {
      const codes = all(email);
      if (codes.length > before) return codes[codes.length - 1];
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`No new sign-in code for ${email} in ${LOG}`);
  };
}
