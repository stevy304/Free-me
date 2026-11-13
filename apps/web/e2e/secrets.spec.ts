import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectCode } from './codes';

/**
 * Administration → Secrets in a real browser: an administrator types a key and saves; the form closes at once, the
 * value is gone from the page, and the page only says the key is set. Uses the outside scanner token, which does
 * nothing without SAFETY_SCAN_URL, so other tests on the same server are not affected; it is removed at the end.
 */
async function signedIn(browser: Browser, email: string, returnTo: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByLabel('Email address').fill(email);
  const code = expectCode(email);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Sign-in code').fill(await code());
  await page.waitForURL((u) => u.pathname === returnTo);
  return page;
}

test('an administrator saves a key: the form disappears and the key is never shown again', async ({ browser }) => {
  const token = `e2e-scan-token-${Date.now().toString(36)}`;
  const admin = await signedIn(browser, 'secrets-admin@example.com', '/admin');
  await admin.getByRole('button', { name: 'Secrets', exact: true }).click();
  const row = admin.getByRole('listitem').filter({ hasText: 'Outside scanner token' });
  await expect(row).toBeVisible();

  await admin.getByRole('button', { name: 'Add or replace keys' }).click();
  const form = admin.getByRole('form', { name: 'Add or replace keys' });
  const field = form.getByLabel('Outside scanner token');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill(token);
  await form.getByRole('button', { name: 'Save' }).click();

  await expect(form).toBeHidden();
  await expect(admin.getByRole('status')).toContainText('never be shown again');
  await expect(row).toContainText('Set here');
  expect(await admin.content()).not.toContain(token);

  // Not sent back after a reload either.
  await admin.reload();
  await admin.getByRole('button', { name: 'Secrets', exact: true }).click();
  await expect(admin.getByRole('listitem').filter({ hasText: 'Outside scanner token' })).toContainText('Set here');
  expect(await admin.content()).not.toContain(token);

  admin.once('dialog', (d) => void d.accept());
  await admin.getByRole('listitem').filter({ hasText: 'Outside scanner token' }).getByRole('button', { name: 'Remove' }).click();
  await expect(admin.getByRole('listitem').filter({ hasText: 'Outside scanner token' })).toContainText('Not set');
});
