import { expect, test } from '@playwright/test';
import { expectCode } from './codes';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const SECRET = process.env.E2E_RTMP_SECRET ?? '';

test('Streamlabs setup protects keys and follows external broadcast state on desktop and mobile', async ({ page }) => {
  test.skip(!SECRET || !process.env.E2E_API_LOG, 'Needs a configured encoder URL, callback secret and console mail log.');
  const email = `encoder.${Date.now()}@example.com`;
  await page.goto('/login?returnTo=/');
  await page.getByLabel('Email address').fill(email);
  const code = expectCode(email);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Sign-in code').fill(await code());
  await page.waitForURL((url) => url.pathname === '/');
  const post = (path: string, data: object = {}) => page.request.post(`${BASE}/api${path}`, { data, headers: { origin: BASE } });
  expect((await post('/channels', { handle: email.split('@')[0], name: 'Encoder QA' })).status()).toBe(201);
  // An administrator (in ADMIN_EMAILS) grants this creator Premium. Its own account: sign-in codes are limited to one a
  // minute per address, so sharing live-admin with live.spec.ts, which signs in right after, left that test without a code.
  const admin = await page.context().browser()!.newContext();
  const adminPage = await admin.newPage();
  await adminPage.goto('/login?returnTo=/');
  await adminPage.getByLabel('Email address').fill('encoder-admin@example.com');
  const adminCode = expectCode('encoder-admin@example.com');
  await adminPage.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await adminPage.getByLabel('Sign-in code').fill(await adminCode());
  await adminPage.waitForURL((url) => url.pathname === '/');
  expect((await adminPage.request.post(`${BASE}/api/admin/billing/premium`, { data: { email, months: 1 }, headers: { origin: BASE } })).ok()).toBe(true);
  await admin.close();

  await page.goto('/studio/live');
  const panel = page.getByRole('region', { name: 'Connect your streaming software' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Streamlabs', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Stream key', { exact: true })).toHaveAttribute('type', 'password');
  await panel.getByRole('button', { name: 'Show stream key' }).click();
  await expect(page.getByLabel('Stream key', { exact: true })).toHaveAttribute('type', 'text');
  await panel.getByRole('button', { name: 'Hide stream key' }).click();
  if (process.env.E2E_SCREENSHOT_DIR) await panel.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/encoder-desktop.png` });
  const previousKey = await page.getByLabel('Stream key', { exact: true }).inputValue();
  await panel.getByRole('button', { name: 'Replace stream key', exact: true }).click();
  await expect(panel.getByText('Your old key will stop working.', { exact: false })).toBeVisible();
  await panel.getByRole('button', { name: 'Replace key now' }).click();
  await expect(page.getByLabel('Stream key', { exact: true })).not.toHaveValue(previousKey);
  await panel.getByRole('button', { name: 'OBS Studio', exact: true }).click();
  await expect(panel.getByText('Set Service to “Custom”.')).toBeVisible();
  await page.getByLabel('Title', { exact: true }).fill('Studio connection rehearsal');
  await panel.getByRole('button', { name: 'Save broadcast title' }).click();
  await expect(panel.getByText('Title saved.', { exact: false })).toBeVisible();
  const { encoder, stream } = await (await page.request.get(`${BASE}/api/hub/live`)).json();
  const callback = (action: string, name: string) => page.request.post(`http://127.0.0.1:4000/api/live/rtmp/${action}?secret=${SECRET}`, { form: { name, app: 'live', flashver: 'FMLE/3.0', clientid: '14', tcurl: encoder.server }, maxRedirects: 0 });
  expect((await callback('publish', encoder.streamKey)).status()).toBe(302);
  await expect(panel.getByText('Encoder connected · On air')).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByRole('button', { name: 'Replace stream key', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'End broadcast' }).click();
  await expect(panel.getByText('Waiting for your encoder')).toBeVisible({ timeout: 15_000 });
  expect((await callback('update', stream.id)).status()).toBe(403);
  expect((await callback('publish', encoder.streamKey)).status()).toBe(403);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  if (process.env.E2E_SCREENSHOT_DIR) await panel.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/encoder-mobile.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
