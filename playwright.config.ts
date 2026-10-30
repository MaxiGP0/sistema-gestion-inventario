import { defineConfig, devices } from '@playwright/test';
import { E2E_AUTH_SECRET, E2E_BASE_URL, E2E_MONGODB_URI, E2E_PORT } from './e2e/config';

/**
 * Playwright corre contra una base efímera sembrada por `e2e/global-setup.ts`.
 * El servidor de Next se levanta en un puerto propio para no chocar con
 * `npm run dev`, y recibe la URI de prueba por entorno.
 *
 * La suite PWA/offline corre aparte con `playwright.pwa.config.ts` sobre un
 * build de producción: el SW y la hidratación del HTML cacheado necesitan un
 * servidor sin HMR. Estas pruebas generales mantienen `next dev` para conservar
 * cookies no-Secure en WebKit y ciclos de iteración rápidos.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: E2E_BASE_URL,
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    // La app registra un service worker con caché de páginas. En los E2E se
    // bloquea para que cada navegación vaya a la red y no interfiera con los
    // cambios de sesión/estado entre pasos.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: [
        /mobile\.spec\.ts/,
        /performance\.spec\.ts/,
        /pwa\.spec\.ts/,
        /offline-catalog\.spec\.ts/,
      ],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    // La suite móvil corre aislada: recorre login, panel, alta y bandeja y
    // valida overflow, tamaño de campos y áreas táctiles en los dos tamaños
    // más usados (Android/Chrome y iPhone/Safari).
    {
      name: 'mobile-pixel-7',
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
      },
    },
    {
      name: 'mobile-iphone-13',
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices['iPhone 13'],
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${E2E_PORT} --hostname 127.0.0.1`,
    url: `${E2E_BASE_URL}/login`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      MONGODB_URI: E2E_MONGODB_URI,
      AUTH_SECRET: E2E_AUTH_SECRET,
      LOG_LEVEL: 'error',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
