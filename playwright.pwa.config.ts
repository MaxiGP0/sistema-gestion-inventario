import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.config';
import { E2E_AUTH_SECRET, E2E_BASE_URL, E2E_MONGODB_URI, E2E_PORT } from './e2e/config';

/**
 * Suite PWA y alta offline sobre un build de producción.
 *
 * El resto de los E2E corren con `next dev` (playwright.config.ts). Estas
 * pruebas necesitan el service worker y la hidratación de un HTML servido desde
 * Cache Storage; con el HMR de desarrollo la hidratación queda pendiente cuando
 * no hay red. También se evita el doble comportamiento de cookies Secure en
 * WebKit porque este proyecto usa Chromium.
 *
 * Ejecutar con: npm run test:e2e:pwa
 */
export default defineConfig({
  ...baseConfig,
  projects: [
    {
      name: 'pwa',
      testMatch: /(pwa|offline-catalog)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        serviceWorkers: 'allow',
      },
    },
  ],
  webServer: {
    command: `npm run build && npm run start -- --port ${E2E_PORT} --hostname 127.0.0.1`,
    url: `${E2E_BASE_URL}/login`,
    reuseExistingServer: false,
    timeout: 600_000,
    env: {
      MONGODB_URI: E2E_MONGODB_URI,
      AUTH_SECRET: E2E_AUTH_SECRET,
      LOG_LEVEL: 'error',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
