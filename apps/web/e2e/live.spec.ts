import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { expectCode } from './codes';

/**
 * Going live from the browser, end to end: a Premium creator (Premium given by an administrator: ADMIN_EMAILS must
 * include live-admin@example.com) opens Live Studio, picks the camera (the browser's fake camera) and goes live; a viewer finds
 * the stream, chats, and sees it end. The browser recording reaches the API over the socket, through the web server.
 */
const LOG = process.env.E2E_API_LOG ?? '';
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const run = Date.now().toString(36);

test.use({
  launchOptions: {
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--allow-loopback-in-peer-connection'],
  },
});

async function signIn(page: Page, email: string) {
  await page.goto('/login?returnTo=/');
  await page.getByLabel('Email address').fill(email);
  const code = expectCode(email);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Sign-in code').fill(await code());
  await page.waitForURL((u) => u.pathname === '/');
}
const post = (page: Page, path: string, data: object) => page.request.post(`${BASE}/api${path}`, { data, headers: { origin: BASE } });

test('a Premium creator goes live from the browser; a viewer watches, chats and sees it end', async ({ browser }) => {
  test.skip(!LOG, 'Set E2E_API_LOG to the API log (MAIL_TRANSPORT=console).');
  test.setTimeout(180_000);
  const hostEmail = `live.${run}@example.com`;

  const host = await (await browser.newContext({ permissions: ['camera', 'microphone'] })).newPage();
  let dropSignal = false;
  let relay: WebSocketRoute | undefined;
  await host.routeWebSocket(/\/api\/socket\?/, (ws) => {
    if (dropSignal) { ws.close({ code: 1011 }); return; }
    relay = ws.connectToServer();
  });
  await signIn(host, hostEmail);
  expect((await post(host, '/channels', { handle: `live.${run}`, name: 'Live Kigali' })).status()).toBe(201);
  await host.goto('/studio/live');
  await expect(host.getByRole('heading', { name: 'Live Studio is part of Premium' })).toBeVisible();

  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, 'live-admin@example.com');
  expect((await post(admin, '/admin/billing/premium', { email: hostEmail, months: 1 })).ok()).toBe(true);

  await host.reload();
  const panels = host.getByRole('complementary', { name: 'Production panels' });
  await panels.getByRole('button', { name: 'Sources', exact: true }).click();
  await host.getByRole('button', { name: 'Camera' }).click();
  await host.getByLabel('Title', { exact: true }).fill(`Morning show ${run}`);
  await panels.getByRole('button', { name: 'Graphics', exact: true }).click();
  await host.getByLabel('Lower third name').fill('Kigali · Morning show');
  const swatch = (index: number) => host.locator('canvas').nth(index).evaluate((canvas: HTMLCanvasElement) =>
    [...canvas.getContext('2d')!.getImageData(34, 582, 1, 1).data]);
  await expect.poll(() => swatch(0)).toEqual([8, 100, 95, 255]);
  await expect.poll(() => swatch(1)).not.toEqual([8, 100, 95, 255]);
  await host.getByRole('button', { name: 'Take to air' }).click();
  await expect.poll(() => swatch(1)).toEqual([8, 100, 95, 255]);
  await host.getByRole('button', { name: 'Go live' }).click();
  await expect(host.getByText(/ON AIR/)).toBeVisible({ timeout: 20_000 });

  // A viewer finds it in "Live now" and opens it.
  const viewer = await (await browser.newContext()).newPage();
  await signIn(viewer, `fan.${run}@example.com`);
  await expect(async () => {
    await viewer.goto('/live');
    await viewer.getByRole('link', { name: new RegExp(`Morning show ${run}`) }).click({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await expect(viewer.getByRole('heading', { name: `Morning show ${run}` })).toBeVisible();
  await expect(viewer.getByText('Live', { exact: true }).first()).toBeVisible();
  const playlist = await viewer.evaluate(() => document.querySelector('video') !== null);
  expect(playlist).toBe(true);

  // Chat reaches the creator at once.
  await viewer.getByLabel('Chat message').fill('Hello from Musanze!');
  await viewer.getByRole('button', { name: 'Send' }).click();
  await panels.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(host.getByText('Hello from Musanze!')).toBeVisible({ timeout: 10_000 });

  // Close the host's connection and reject reconnects until both screens show the interruption.
  const video = viewer.locator('video');
  const playbackTime = () => video.evaluate((element) => (element as HTMLVideoElement).currentTime);
  await expect.poll(playbackTime, { timeout: 20_000 }).toBeGreaterThan(0);
  const watchPage = viewer.url();
  const droppedAt = Date.now();
  dropSignal = true;
  await relay!.close({ code: 1011 });
  await expect(host.getByText(/^Reconnecting · /)).toBeVisible();
  await expect(viewer.getByText('Host reconnecting')).toBeVisible();
  await expect(viewer.getByText('Hello from Musanze!')).toBeVisible();
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, 10_000 - (Date.now() - droppedAt))));
  dropSignal = false;
  await expect(host.getByText(/ON AIR/)).toBeVisible({ timeout: 20_000 });
  await expect(viewer.getByText('Host reconnecting')).toBeHidden();
  const restoredAt = await playbackTime();
  await expect.poll(playbackTime, { timeout: 20_000 }).toBeGreaterThan(restoredAt + 1);
  expect(viewer.url()).toBe(watchPage);

  // A viewer can choose either rendition and return to automatic quality on the same player.
  const quality = viewer.getByLabel('Quality', { exact: true });
  const height = () => video.evaluate((element) => (element as HTMLVideoElement).videoHeight);
  await quality.selectOption({ label: '360p' });
  await expect.poll(height, { timeout: 30_000 }).toBe(360);
  await quality.selectOption({ label: '720p' });
  await expect.poll(height, { timeout: 30_000 }).toBe(720);
  await quality.selectOption('-1');
  await expect(quality).toHaveValue('-1');
  expect(viewer.url()).toBe(watchPage);


  // The creator ends it; the viewer is told.
  await host.getByRole('button', { name: 'End broadcast' }).click();
  await expect(viewer.getByText('This stream has ended')).toBeVisible({ timeout: 30_000 });
});

test('free host adds a signed-in WebRTC guest to the program', async ({ browser }) => {
  test.skip(!LOG, 'Set E2E_API_LOG to the API log (MAIL_TRANSPORT=console).');
  const host = await (await browser.newContext({ permissions: ['camera', 'microphone'] })).newPage();
  const guest = await (await browser.newContext({ permissions: ['camera', 'microphone'] })).newPage();
  await signIn(host, `cohost.${run}@example.com`);
  expect((await post(host, '/channels', { handle: `cohost.${run}`, name: 'Co-stream Kigali' })).status()).toBe(201);
  await host.goto('/go-live');
  await host.getByRole('button', { name: 'Camera' }).click();
  await host.getByRole('button', { name: 'Create guest invite' }).click();
  const invite = await host.getByRole('textbox', { name: 'Guest invitation link' }).inputValue();

  await signIn(guest, `guest.${run}@example.com`);
  await guest.goto(invite);
  await guest.getByRole('button', { name: 'Join with camera and microphone' }).click();
  await expect(guest.getByText('Connected. The host decides when to put you on air.')).toBeVisible({ timeout: 20_000 });
  await host.getByRole('button', { name: 'Add to program' }).click();
  await expect(host.getByText(/Guest 1 · In program/)).toBeVisible();
  await host.getByRole('button', { name: 'Go live', exact: true }).click();
  await expect(host.getByText(/^Live · /)).toBeVisible({ timeout: 20_000 });
  await host.getByRole('button', { name: 'End stream' }).click();
  await expect(guest.getByText('The green room closed or disconnected.')).toBeVisible({ timeout: 30_000 });
});
