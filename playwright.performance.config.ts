import { defineConfig, devices } from '@playwright/test';
import { E2E_AUTH_SECRET, E2E_BASE_URL, E2E_MONGODB_URI, E2E_PORT } from './e2e/config';

/**
 * Performance móvil sobre un build de producción.
 *
 * Corre el spec `performance.spec.ts` con el perfil Pixel 7 (Chromium), CPU 4x
 * y red Fast 3G. Necesita `npm run build` antes de `perf:playwright:run`; el
 * script `perf:playwright` hace el build por vos.
 *
 * El servidor y la base efímera se levantan igual que en el resto de los E2E.
 * La suite general (`playwright.config.ts`) ignora este spec para no medir con
 * el HMR de `next dev`.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /[\\/]performance\.spec\.ts$/,
  outputDir: 'test-results/performance',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: E2E_BASE_URL,
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'mobile-performance',
      use: {
        ...devices['Pixel 7'],
      },
    },
  ],
  webServer: {
    command: `npm run start -- --port ${E2E_PORT} --hostname 127.0.0.1`,
    url: `${E2E_BASE_URL}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      MONGODB_URI: E2E_MONGODB_URI,
      AUTH_SECRET: E2E_AUTH_SECRET,
      LOG_LEVEL: 'error',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
