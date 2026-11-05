import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a running web app and API (see e2e/README section in apps/web/e2e/journey.spec.ts).
 * E2E_BASE_URL: the web app; E2E_API_LOG: the API log, where MAIL_TRANSPORT=console prints sign-in codes.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : undefined,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
