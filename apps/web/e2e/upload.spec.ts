import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A creator uploads a video through the upload dialog, fills in the details while it uploads, publishes it, and the
 * media worker turns it into adaptive HLS. Needs the API (MAIL_TRANSPORT=console, logging to E2E_API_LOG), the media
 * worker and the web app running, and ffmpeg to make the test clip.
 */
const LOG = process.env.E2E_API_LOG ?? '';
const run = Date.now().toString(36);

async function codeFor(email: string) {
  const re = new RegExp(`to ${email.replace(/[.+]/g, '\\$&')}: (\\d{6})`, 'g');
  for (let i = 0; i < 60; i++) { const m = [...readFileSync(LOG, 'utf8').matchAll(re)].pop(); if (m) return m[1]; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('no code');
}

test('upload, details, publish, processing to every quality, then on the home page and in Studio', async ({ page }) => {
  test.skip(!LOG, 'Set E2E_API_LOG.');
  test.setTimeout(180_000);
  const dir = mkdtempSync(join(tmpdir(), 'fm-e2e-'));
  const clip = join(dir, `Morning in Kigali ${run}.mp4`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', clip]);

  const email = `uploader.${run}@example.com`;
  await page.goto('/login?returnTo=/channel/create');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Sign-in code').fill(await codeFor(email));
  await page.waitForURL(/channel\/create/);
  await page.getByLabel('Name').fill('Kigali Mornings');
  await page.getByLabel('Handle').fill(`kigali.${run}`);
  await expect(page.getByLabel('Available')).toBeVisible();
  await page.getByRole('button', { name: 'Create channel' }).click();
  await expect(page.getByRole('heading', { name: 'Kigali Mornings' })).toBeVisible();

  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('menuitem', { name: 'Upload video' }).click();
  await page.locator('input[type=file]').setInputFiles(clip);
  await expect(page.getByLabel('Title (required)')).toHaveValue(`Morning in Kigali ${run}`);
  await page.getByLabel('Description').fill('Six seconds of test pattern.');
  await page.getByText("No, it's not made for kids").click();
  await page.getByLabel('Category').selectOption('travel-events');
  await page.locator('label').filter({ hasText: 'Everyone can find and watch it' }).click();
  await expect(page.getByText(/Processing complete · 720p/)).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Published')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  await page.goto('/studio');
  await expect(page.getByText(`Morning in Kigali ${run}`)).toBeVisible();
  await expect(page.getByRole('cell', { name: '720p' })).toBeVisible();
  // Media moves to the public prefix in the background; then the video is on the home page with its thumbnail.
  await expect(async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: `Morning in Kigali ${run}` })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  const thumb = page.getByRole('link', { name: `Morning in Kigali ${run}` }).first().locator('img');
  await expect(thumb).toHaveAttribute('src', /\/pub\/[0-9a-f-]{36}\/thumbs\/\d\.jpg$/);
  await page.getByRole('heading', { name: `Morning in Kigali ${run}` }).click();
  await expect(page).toHaveURL(/\/watch\?v=/);
  await expect(page.locator('video')).toBeAttached();
  const master = await page.evaluate(async () => (await (await fetch(`/api/videos/${new URLSearchParams(location.search).get('v')}`)).json()).video.playbackUrl as string);
  const text = await (await page.request.get(master)).text();
  expect(text.match(/#EXT-X-STREAM-INF/g)).toHaveLength(5);
});
