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
  let hostSocket: WebSocketRoute | undefined;
  await host.routeWebSocket(/\/api\/socket\?/, (ws) => {
    if (dropSignal) { ws.close({ code: 4001 }); return; }
    hostSocket = ws;
    ws.connectToServer();
  });
  await signIn(host, hostEmail);
  expect((await post(host, '/channels', { handle: `live.${run}`, name: 'Live Kigali' })).status()).toBe(201);
  await host.goto('/studio/live');
  await expect(host.getByRole('heading', { name: 'Signal Room is part of Premium' })).toBeVisible();

  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, 'live-admin@example.com');
  expect((await post(admin, '/admin/billing/premium', { email: hostEmail, months: 1 })).ok()).toBe(true);

  await host.reload();
  await expect(host.getByRole('heading', { name: 'Signal Room', exact: true })).toBeVisible();
  await expect(host.getByRole('region', { name: 'Production monitors' })).toBeVisible();
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
  const viewer = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
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
  const supportsH264 = await viewer.evaluate(() =>
    typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="avc1.4d401f,mp4a.40.2"'));
  const watchPage = viewer.url();
  const streamId = new URL(watchPage).pathname.split('/').at(-1);
  const info = await viewer.request.get(`${BASE}/api/live/${streamId}`);
  expect(info.ok()).toBe(true);
  const playlistUrl: string = (await info.json()).stream.playbackUrl;
  const segments = async () => {
    const response = await viewer.request.get(playlistUrl);
    if (!response.ok()) return { url: playlistUrl, items: [] };
    const playlist = await response.text();
    const variant = playlist.split(/\r?\n/).find((line) => line === '360p.m3u8');
    if (!variant) return { url: playlistUrl, items: playlist.split(/\r?\n/).filter((line) => line.endsWith('.ts')) };
    const url = new URL(variant, playlistUrl).href;
    const variantResponse = await viewer.request.get(url);
    return { url, items: variantResponse.ok() ? (await variantResponse.text()).split(/\r?\n/).filter((line) => line.endsWith('.ts')) : [] };
  };
  // The CI Chromium build may lack H.264. Every browser run still verifies media delivery.
  await expect.poll(async () => (await segments()).items.length, { timeout: 20_000 }).toBeGreaterThan(0);
  if (supportsH264) await expect.poll(playbackTime, { timeout: 20_000 }).toBeGreaterThan(0);
  const droppedAt = Date.now();
  dropSignal = true;
  await hostSocket!.close({ code: 4001 });
  await expect(host.getByText(/^Reconnecting · /)).toBeVisible();
  await expect(viewer.getByText('Host reconnecting')).toBeVisible();
  await expect(viewer.getByText('Hello from Musanze!')).toBeVisible();
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, 10_000 - (Date.now() - droppedAt))));
  const segmentsDuringOutage = (await segments()).items.length;
  dropSignal = false;
  await expect(host.getByText(/ON AIR/)).toBeVisible({ timeout: 20_000 });
  await expect(viewer.getByText('Host reconnecting')).toBeHidden();
  await expect.poll(async () => (await segments()).items.length, { timeout: 20_000 }).toBeGreaterThan(segmentsDuringOutage);
  const { url, items } = await segments();
  const latest = items.at(-1)!;
  const media = await viewer.request.get(new URL(latest, url).href);
  expect(media.ok()).toBe(true);
  expect((await media.body()).byteLength).toBeGreaterThan(1000);
  if (supportsH264) {
    const restoredAt = await playbackTime();
    await expect.poll(playbackTime, { timeout: 20_000 }).toBeGreaterThan(restoredAt + 1);
    // The live player's quality menu (controls show while the pointer is over the picture).
    const quality = viewer.getByRole('button', { name: 'Quality', exact: true });
    const pick = async (label: string) => {
      await viewer.getByLabel('Live video').hover();
      await quality.click();
      await viewer.getByRole('menuitemradio', { name: label, exact: true }).click();
    };
    const height = () => video.evaluate((element) => (element as HTMLVideoElement).videoHeight);
    await pick('360p');
    await expect.poll(height, { timeout: 30_000 }).toBe(360);
    await pick('720p');
    await expect.poll(height, { timeout: 30_000 }).toBe(720);
    await pick('Auto');
    await expect(quality).toHaveText(/^Auto/);
    // The live-edge control: "Live" at the newest pieces; "Go to live" when behind (after the outage and quality
    // switches above the player may be), which brings the viewer back to the edge.
    await viewer.getByLabel('Live video').hover();
    const edge = viewer.getByRole('button', { name: /^(Live$|Go to live)/ });
    await expect(edge).toBeVisible();
    if ((await edge.getAttribute('aria-label')) !== 'Live') await edge.click();
    await expect(viewer.getByRole('button', { name: 'Live', exact: true })).toBeVisible({ timeout: 15_000 });
  }
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
  await expect(host.getByText(/^On air · /)).toBeVisible({ timeout: 20_000 });
  // Ending asks first, so a stream is never ended by a stray tap.
  await host.getByRole('button', { name: 'End stream' }).click();
  await host.getByRole('alertdialog', { name: 'End the stream?' }).getByRole('button', { name: 'End stream' }).click();
  await expect(guest.getByText('The green room closed or disconnected.')).toBeVisible({ timeout: 30_000 });
});
