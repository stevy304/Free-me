import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * The main journeys, in a real browser, against the real API and database:
 * sign in with an emailed code, create a channel, follow from a second account, edit a profile, search, sign out.
 * Needs: the web app at E2E_BASE_URL and an API started with MAIL_TRANSPORT=console logging to E2E_API_LOG.
 */
const LOG = process.env.E2E_API_LOG ?? '';
const run = Date.now().toString(36);

async function codeFor(email: string): Promise<string> {
  const pattern = new RegExp(`to ${email.replace(/[.+]/g, '\\$&')}: (\\d{6}) is your Free Me sign-in code`, 'g');
  for (let i = 0; i < 60; i++) {
    const m = [...readFileSync(LOG, 'utf8').matchAll(pattern)].pop();
    if (m) return m[1];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No sign-in code for ${email} in ${LOG}`);
}

async function signIn(page: Page, email: string, returnTo = '/') {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.getByLabel('Sign-in code').fill(await codeFor(email));
  await page.waitForURL((u) => u.pathname === returnTo.split('?')[0]);
}

test('a creator signs in, creates a channel; a viewer follows, edits their profile, searches and signs out', async ({ browser }) => {
  test.skip(!LOG, 'Set E2E_API_LOG to the API log (MAIL_TRANSPORT=console).');
  const handle = `e2e.${run}`;

  const creator = await (await browser.newContext()).newPage();
  await creator.goto('/channel/create');
  await expect(creator).toHaveURL(/\/login\?returnTo=(%2F|\/)channel(%2F|\/)create/);
  await signIn(creator, `creator.${run}@example.com`, '/channel/create');
  await creator.getByLabel('Name').fill('End to End Kitchen');
  await creator.getByLabel('Handle').fill(handle);
  await expect(creator.getByLabel('Available')).toBeVisible();
  await creator.getByLabel('Country').selectOption('KE');
  await creator.getByRole('button', { name: 'Create channel' }).click();
  await expect(creator.getByRole('heading', { name: 'End to End Kitchen' })).toBeVisible();
  await expect(creator.getByRole('link', { name: 'Customize channel' })).toBeVisible();

  const viewer = await (await browser.newContext({ locale: 'fr-FR' })).newPage();
  const errors: string[] = [];
  viewer.on('pageerror', (e) => errors.push(e.message));
  await signIn(viewer, `viewer.${run}@example.com`);
  await viewer.goto(`/@${handle}`);
  await viewer.getByRole('button', { name: 'Follow', exact: true }).click();
  await expect(viewer.getByRole('button', { name: 'Following' })).toBeVisible();
  await viewer.reload();
  await expect(viewer.getByText('1 follower')).toBeVisible();
  await viewer.goto('/following');
  await expect(viewer.getByRole('main').getByText('End to End Kitchen')).toBeVisible();

  await viewer.goto('/settings');
  await viewer.locator('#country').selectOption('JP');
  await viewer.locator('#lang').selectOption('ja');
  await viewer.locator('#profile').getByRole('button', { name: 'Save' }).click();
  await expect(viewer.locator('#profile').getByText('Saved')).toBeVisible();
  await viewer.reload();
  await expect(viewer.locator('#country')).toHaveValue('JP');

  await viewer.getByRole('combobox', { name: 'Search' }).fill('End to End');
  await viewer.keyboard.press('Enter');
  await expect(viewer).toHaveURL(/\/results\?q=End/);
  await expect(viewer.getByText(`@${handle}`)).toBeVisible();

  await viewer.goto('/you');
  await viewer.getByRole('button', { name: 'Sign out' }).click();
  await expect(viewer.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();
  await viewer.goto('/settings');
  await expect(viewer).toHaveURL(/\/login/);
  expect(errors).toEqual([]);
});

test('unknown pages and channels show a clear message; phones get the bottom bar without sideways scrolling', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await page.goto('/@no-such-channel-here');
  await expect(page.getByRole('heading', { name: "This page isn't available" })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' }).last().getByRole('link', { name: 'Home' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
