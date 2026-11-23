import { defineConfig, devices } from '@playwright/test';

const SERVER_PORT = 8797;
const CLIENT_PORT = 5183;

export default defineConfig({
  testDir: 'packages/client/e2e',
  testMatch: '*.e2e.ts',
  timeout: 60_000,
  use: { baseURL: `http://localhost:${CLIENT_PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: 'determinism.e2e.ts' },
    // Firefox follows the system proxy even for localhost, which breaks the dev server behind a local one.
    { name: 'firefox', use: { ...devices['Desktop Firefox'], launchOptions: { firefoxUserPrefs: { 'network.proxy.type': 0 } } }, testMatch: 'determinism.e2e.ts' },
  ],
  webServer: [
    {
      command: 'pnpm --filter @golix/server start',
      url: `http://localhost:${SERVER_PORT}/rooms`,
      env: { PORT: String(SERVER_PORT) },
      reuseExistingServer: false,
    },
    {
      command: `pnpm --filter @golix/client dev --port ${CLIENT_PORT} --strictPort`,
      url: `http://localhost:${CLIENT_PORT}`,
      env: { VITE_SERVER_URL: `ws://localhost:${SERVER_PORT}` },
      reuseExistingServer: false,
    },
  ],
});
