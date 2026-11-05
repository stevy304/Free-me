import { expect, test, type Browser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Watching and community features in a real browser: like, save to collections, comment and reply, history,
 * reporting, a moderator removing the video, and the creator seeing the removal in Creator Hub.
 * Needs the API (MAIL_TRANSPORT=console, ADMIN_EMAILS containing admin@example.com, logging to E2E_API_LOG),
 * the media worker, the web app, and ffmpeg.
 */
const LOG = process.env.E2E_API_LOG ?? '';
const run = Date.now().toString(36);

async function codeFor(email: string) {
  const re = new RegExp(`to ${email.replace(/[.+]/g, '\\$&')}: (\\d{6})`, 'g');
  for (let i = 0; i < 60; i++) { const m = [...readFileSync(LOG, 'utf8').matchAll(re)].pop(); if (m) return m[1]; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`No sign-in code for ${email}`);
}
async function signedIn(browser: Browser, email: string, returnTo = '/'): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Sign-in code').fill(await codeFor(email));
  await page.waitForURL((u) => u.pathname === returnTo.split('?')[0]);
  return page;
}

test('like, save, comment, history, report; a moderator removes the video; the creator sees why', async ({ browser }) => {
  test.skip(!LOG, 'Set E2E_API_LOG.');
  test.setTimeout(240_000);
  const title = `Lake at dawn ${run}`;
  const dir = mkdtempSync(join(tmpdir(), 'fm-e2e-'));
  const clip = join(dir, `${title}.mp4`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=5', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', clip]);

  // Creator publishes a video.
  const creator = await signedIn(browser, `lake.${run}@example.com`, '/channel/create');
  await creator.getByLabel('Name').fill('Lake Films');
  await creator.getByLabel('Handle').fill(`lake.${run}`);
  await expect(creator.getByLabel('Available')).toBeVisible();
  await creator.getByRole('button', { name: 'Create channel' }).click();
  await expect(creator.getByRole('heading', { name: 'Lake Films' })).toBeVisible();
  await creator.getByRole('button', { name: 'Create' }).click();
  await creator.getByRole('menuitem', { name: 'Upload video' }).click();
  await creator.locator('input[type=file]').setInputFiles(clip);
  await creator.getByText("No, it's not made for kids").click();
  await creator.locator('label').filter({ hasText: 'Everyone can find and watch it' }).click();
  await expect(creator.getByText(/Processing complete/)).toBeVisible({ timeout: 120_000 });
  await creator.getByRole('button', { name: 'Save' }).click();
  await expect(creator.getByText('Published')).toBeVisible();
  const videoId = await creator.evaluate(async (t) => {
    const r = await (await fetch('/api/hub/videos')).json();
    return (r.videos as Array<{ id: string; title: string }>).find((v) => v.title === t)!.id;
  }, title);

  // A viewer likes, saves, comments and replies.
  const viewer = await signedIn(browser, `fan.${run}@example.com`);
  const errors: string[] = [];
  viewer.on('pageerror', (e) => errors.push(e.message));
  await expect(async () => { await viewer.goto(`/watch?v=${videoId}`); await expect(viewer.getByRole('heading', { name: title })).toBeVisible({ timeout: 2000 }); }).toPass({ timeout: 30_000 });
  await viewer.getByRole('button', { name: /^Like/ }).click();
  await expect(viewer.getByRole('button', { name: 'Like (1)' })).toHaveAttribute('aria-pressed', 'true');

  await viewer.getByRole('button', { name: 'Save', exact: true }).click();
  const save = viewer.getByRole('dialog', { name: 'Save to…' });
  await save.getByRole('checkbox', { name: /Saved/ }).click();
  await expect(save.getByRole('checkbox', { name: /Saved/ })).toHaveAttribute('aria-checked', 'true');
  await save.getByRole('button', { name: 'New collection' }).click();
  await save.getByLabel('Name').fill('Calm mornings');
  await save.getByRole('button', { name: 'Create' }).click();
  await expect(save.getByRole('checkbox', { name: /Calm mornings/ })).toHaveAttribute('aria-checked', 'true');
  await save.getByRole('button', { name: 'Close' }).click();
  await expect(viewer.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();

  await viewer.getByLabel('Add a comment…').fill('What a peaceful place.');
  await viewer.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(viewer.getByText('What a peaceful place.')).toBeVisible();
  await expect(viewer.getByRole('heading', { name: '1 comment' })).toBeVisible();
  await viewer.getByRole('button', { name: 'Reply' }).first().click();
  await viewer.getByLabel('Add a reply…').fill('Where was this filmed?');
  await viewer.getByRole('button', { name: 'Reply', exact: true }).last().click();
  await expect(viewer.getByText('Where was this filmed?')).toBeVisible();
  await expect(viewer.getByRole('heading', { name: '2 comments' })).toBeVisible();

  // Watching is remembered in History. Playwright's Chromium has no H.264 decoder, so the test sends the position
  // the way the player does after 10 seconds of playback.
  await viewer.evaluate(async (id) => { await fetch(`/api/videos/${id}/progress`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds: 2 }) }); }, videoId);
  await expect(async () => {
    await viewer.goto('/history');
    await expect(viewer.getByRole('heading', { name: title })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await viewer.goto('/collections');
  await expect(viewer.getByText('Calm mornings')).toBeVisible();
  await viewer.goto('/collection/saved');
  await expect(viewer.getByRole('heading', { name: title })).toBeVisible();

  // The viewer reports it.
  await viewer.goto(`/watch?v=${videoId}`);
  await viewer.getByRole('button', { name: 'More actions' }).click();
  await viewer.getByRole('menuitem', { name: 'Report' }).click();
  const report = viewer.getByRole('dialog', { name: 'Report video' });
  await report.getByText('Spam or scam').click();
  await report.getByLabel('Details (optional)').fill('The description links to a fake giveaway.');
  await report.getByRole('button', { name: 'Report' }).click();
  await expect(viewer.getByRole('dialog', { name: 'Thanks for reporting' })).toBeVisible();

  // A moderator removes it.
  const admin = await signedIn(browser, 'admin@example.com', '/moderation');
  await expect(admin.getByRole('heading', { name: 'Moderation' })).toBeVisible();
  const item = admin.locator('article').filter({ hasText: title });
  await expect(item.getByText('The description links to a fake giveaway.')).toBeVisible();
  await item.getByRole('button', { name: 'Remove video' }).click();
  const decide = admin.getByRole('dialog', { name: 'Remove video' });
  await decide.getByLabel(/Reason the creator will read/).fill('Links to a scam in the description.');
  await decide.getByRole('button', { name: 'Confirm' }).click();
  await expect(admin.getByText('Nothing to review here.')).toBeVisible();

  // Gone for viewers, explained to the creator.
  await viewer.goto(`/watch?v=${videoId}`);
  await expect(viewer.getByRole('heading', { name: 'Video unavailable' })).toBeVisible();
  await expect(viewer.getByText('This video was removed for breaking the Community Guidelines.')).toBeVisible();
  await creator.goto('/hub?tab=notices');
  await expect(creator.getByText(title)).toBeVisible();
  await expect(creator.getByText('Links to a scam in the description.')).toBeVisible();
  await expect(creator.getByText('Community Guidelines strikes in the last 90 days')).toBeVisible();
  expect(errors).toEqual([]);
});
