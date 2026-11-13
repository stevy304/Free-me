import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectCode } from './codes';

/**
 * A creator uploads a video through the upload dialog, fills in the details while it uploads, publishes it, and the
 * media worker turns it into adaptive HLS. Needs the API (MAIL_TRANSPORT=console, logging to E2E_API_LOG), the media
 * worker and the web app running, and ffmpeg to make the test clip.
 */
const LOG = process.env.E2E_API_LOG ?? '';
const run = Date.now().toString(36);


test('upload, details, publish, processing to every quality, then on the home page and in Creator Hub', async ({ page }) => {
  test.skip(!LOG, 'Set E2E_API_LOG.');
  test.setTimeout(180_000);
  const dir = mkdtempSync(join(tmpdir(), 'fm-e2e-'));
  const clip = join(dir, `Morning in Kigali ${run}.mp4`);
  // A big, noisy photo (well over 2 MB): the browser shrinks it before uploading.
  const photo = join(dir, 'cover.png');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=3000x2000', '-vf', 'noise=alls=60:allf=t', '-frames:v', '1', photo]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', '-metadata', `comment=e2e ${run}`, clip]);

  const email = `uploader.${run}@example.com`;
  await page.goto('/login?returnTo=/channel/create');
  await page.getByLabel('Email address').fill(email);
  const code = expectCode(email);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Sign-in code').fill(await code());
  await page.waitForURL(/channel\/create/);
  await page.getByLabel('Name').fill('Kigali Mornings');
  await page.getByLabel('Handle').fill(`kigali.${run}`);
  await expect(page.getByLabel('Available')).toBeVisible();
  await page.getByRole('button', { name: 'Create Space' }).click();
  await expect(page.getByRole('heading', { name: 'Kigali Mornings' })).toBeVisible();

  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('menuitem', { name: 'Upload video' }).click();
  const launchpad = page.getByRole('dialog', { name: 'Launchpad' });
  await expect(launchpad).toBeVisible();
  await launchpad.locator('input[type=file]').setInputFiles(clip);
  await expect(launchpad.getByRole('list', { name: 'Upload steps' })).toBeVisible();
  await expect(page.getByLabel('Title (required)')).toHaveValue(`Morning in Kigali ${run}`);
  await page.getByLabel('Description').fill('Six seconds of test pattern.');
  await page.getByText("No, it's not made for kids").click();
  await page.getByLabel('Category').selectOption('travel-events');
  await page.locator('label').filter({ hasText: 'Everyone can find and watch it' }).click();
  await expect(page.getByText(/Processing complete · 720p/)).toBeVisible({ timeout: 120_000 });
  await expect(launchpad.getByText('Ready to watch', { exact: true })).toHaveAttribute('aria-current', 'step');
  await expect(launchpad.getByRole('link', { name: 'Open video' })).toBeVisible();
  expect(readFileSync(photo).length).toBeGreaterThan(2 * 1024 * 1024);
  await page.locator('input[type=file][accept="image/*"]').setInputFiles(photo);
  await expect(page.getByText('Thumbnail updated')).toBeVisible({ timeout: 20_000 });
  // Captions: an SRT file in English.
  const srt = join(dir, 'captions.srt');
  writeFileSync(srt, '1\n00:00:00,500 --> 00:00:03,000\nGood morning, Kigali\n\n2\n00:00:03,000 --> 00:00:05,500\nWelcome to Free Me\n');
  await page.locator('#v-cap-lang').selectOption('en');
  await page.locator('input[type=file][accept^=".vtt"]').setInputFiles(srt);
  await expect(page.getByText('English captions added')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('2 lines')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Published')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  await page.goto('/hub');
  await expect(page.getByText(`Morning in Kigali ${run}`)).toBeVisible();
  await expect(page.getByRole('cell', { name: '720p' })).toBeVisible();
  // Media (and the custom thumbnail) moves to the public prefix in the background; then the video is on the home page.
  await expect(async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: `Morning in Kigali ${run}` }).first()).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  const thumb = page.getByRole('link', { name: `Morning in Kigali ${run}` }).first().locator('img');
  await expect(thumb).toHaveAttribute('src', /\/pub\/[0-9a-f-]{36}\/thumbs\/custom-\d+\.jpg$/);
  expect((await page.request.get((await thumb.getAttribute('src'))!)).status()).toBe(200);
  await page.getByRole('heading', { name: `Morning in Kigali ${run}` }).first().click();
  await expect(page).toHaveURL(/\/watch\?v=/);
  await expect(page.locator('video track[srclang="en"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Subtitles (c)' }).first()).toBeAttached();
  await expect(page.locator('video')).toBeAttached();
  // Captions are on by default: the English track is live with its lines (the test browser cannot decode H.264, so
  // the lines themselves are not drawn here).
  await expect(page.getByRole('button', { name: 'Subtitles (c)' }).first()).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => { const t = document.querySelector('video')!.textTracks[0]; return `${t.mode}:${t.cues?.length ?? 0}`; })).toBe('hidden:2');
  const master = await page.evaluate(async () => (await (await fetch(`/api/videos/${new URLSearchParams(location.search).get('v')}`)).json()).video.playbackUrl as string);
  const text = await (await page.request.get(master)).text();
  expect(text.match(/#EXT-X-STREAM-INF/g)).toHaveLength(5);

  // Drive the native media events so the recovery flow can run even on Chromium builds without H.264.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Safari', configurable: true });
    const canPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      return type === 'application/vnd.apple.mpegurl' ? 'probably' : canPlayType.call(this, type);
    };
  });
  const watchUrl = page.url();
  await page.evaluate(() => localStorage.setItem('fm_speed', '1.5'));
  await page.reload();
  const player = page.locator('video');
  await expect(player).toHaveAttribute('src', /master\.m3u8/);
  await player.evaluate((element: HTMLVideoElement) => {
    let position = 3;
    Object.defineProperties(element, {
      currentTime: { get: () => position, set: (value: number) => { position = value; } },
      error: { get: () => navigator.onLine ? null : { code: 2 } },
      play: { value: () => {
        element.dataset.resumedAt = String(position);
        element.dispatchEvent(new Event('play'));
        element.dispatchEvent(new Event('playing'));
        return Promise.resolve();
      } },
    });
    element.dispatchEvent(new Event('play'));
    element.dispatchEvent(new Event('timeupdate'));
  });
  // The recovery report specifically: the startup report can arrive at any time, whenever the first frame shows.
  const recoveryReport = page.waitForResponse((response) => response.url().endsWith('/playback-health') && response.request().method() === 'POST' && response.request().postDataJSON()?.kind === 'recovery');
  await page.context().setOffline(true);
  try {
    await player.evaluate((element: HTMLVideoElement) => {
      element.dispatchEvent(new Event('pause'));
      element.dispatchEvent(new Event('error'));
      element.currentTime = 0;
      element.playbackRate = 1;
    });
    await expect(page.getByText('Your place · 0:03')).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }
  await expect(page.getByText('Waiting for connection')).toBeHidden();
  await player.dispatchEvent('loadedmetadata');
  await expect(player).toHaveAttribute('data-resumed-at', '3');
  const reported = await recoveryReport;
  expect(reported.ok()).toBe(true);
  expect(reported.request().postDataJSON()).toMatchObject({ kind: 'recovery', durationMs: expect.any(Number) });
  await expect.poll(() => player.evaluate((element: HTMLVideoElement) => element.playbackRate)).toBe(1.5);
  await expect(page).toHaveURL(watchUrl);

});
