import { expect, test, type Page } from '@playwright/test';
import { expectCode } from './codes';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
test.use({ launchOptions: { ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}), args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
async function setup(page: Page, tag: string) {
  const email = `desk.${tag}.${Date.now()}@example.com`;
  await page.goto('/login?returnTo=/');
  await page.getByLabel('Email address').fill(email);
  const code = expectCode(email);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Sign-in code').fill(await code());
  await page.waitForURL((url) => url.pathname === '/');
  expect((await page.request.post(`${BASE}/api/channels`, { data: { handle: email.split('@')[0], name: 'Studio Layout' }, headers: { origin: BASE } })).status()).toBe(201);
  await page.goto('/go-live');
  await expect(page.getByRole('heading', { name: 'Go Live', exact: true })).toBeVisible();
}

test('the desk fits laptop and desktop viewports, connects devices, preserves mute and stays usable on phones', async ({ page }, testInfo) => {
  test.skip(!process.env.E2E_API_LOG, 'Needs a running API with console mail.');
  await page.context().grantPermissions(['camera', 'microphone']);
  await page.setViewportSize({ width: 1366, height: 768 });
  await setup(page, 'layout');
  const desk = page.getByTestId('live-studio');
  const go = page.getByRole('button', { name: 'Go live', exact: true });
  await expect(go).toBeDisabled();
  await page.getByRole('button', { name: 'Camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Camera', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(go).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Input status' }).getByText(/\d+ × \d+/)).toBeVisible();
  for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size);
    expect(await desk.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const footer = await desk.locator('footer').boundingBox();
    for (const name of ['Production monitors', 'Guest green room', 'Scenes', 'Audio mixer', 'Sources', 'Live chat']) {
      const card = page.getByRole('region', { name, exact: true });
      await expect(card).toBeVisible();
      const box = await card.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(footer!.y + 1);
    }
    await page.screenshot({ path: testInfo.outputPath(`go-live-${size.width}.png`), animations: 'disabled' });
  }
  await page.getByRole('button', { name: 'Microphone', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Microphone', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Devices', exact: true }).click();
  await expect(page.getByLabel('Camera device')).toBeVisible();
  await expect(page.getByLabel('Microphone device')).toBeVisible();
  await page.getByLabel('Camera device').selectOption('');
  await expect(page.getByRole('button', { name: 'Connect camera and microphone' })).toBeEnabled();
  await page.getByRole('dialog', { name: 'Studio tools' }).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Microphone', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Select Starting soon scene', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select Starting soon scene', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Select Camera scene', exact: true }).click();
  await page.getByRole('button', { name: 'Camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Camera', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await desk.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Broadcast settings' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Broadcast settings' }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('go-live-mobile.png'), animations: 'disabled' });
});

test('denied device permission shows actionable feedback and does not enable broadcasting', async ({ page }) => {
  test.skip(!process.env.E2E_API_LOG, 'Needs a running API with console mail.');
  await page.addInitScript(() => { if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); }; });
  await setup(page, 'denied');
  await page.getByRole('button', { name: 'Camera', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('permission was denied');
  await expect(page.getByRole('button', { name: 'Go live', exact: true })).toBeDisabled();
});
