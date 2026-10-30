/**
 * Pruebas de la política del service worker y del aviso de actualización.
 *
 * No ejecutan un navegador: validan que `public/sw.js` conserve las garantías
 * que sostienen el resto del diseño (precache acotado, navegaciones sin caché,
 * catálogo acotado, actualización explícita y limpieza al logout). El
 * comportamiento real se cubre en `e2e/pwa.spec.ts`.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const swSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const managerSource = readFileSync(
  new URL('../components/ServiceWorkerManager.tsx', import.meta.url),
  'utf8',
);
const userContextSource = readFileSync(
  new URL('../context/UserContext.tsx', import.meta.url),
  'utf8',
);

test('las cachés se versionan con el build id que llega en la URL del SW', () => {
  assert.match(swSource, /new URL\(self\.location\.href\)\.searchParams\.get\('v'\)/);
  assert.match(swSource, /const STATIC_CACHE = `sgi-static-\$\{BUILD_ID\}`;/);
  assert.match(swSource, /const CATALOG_CACHE = `sgi-catalog-\$\{BUILD_ID\}`;/);
});

test('el precache sólo incluye estáticos y el shell offline', () => {
  assert.match(swSource, /const PRECACHE_URLS = \[/);
  assert.match(swSource, /OFFLINE_PAGE,/);
  assert.match(swSource, /'\/manifest\.webmanifest'/);
  assert.match(swSource, /'\/icons\/icon-192\.png'/);

  // Ninguna página con datos de negocio ni el HTML de la app.
  const precacheBlock = swSource.match(/const PRECACHE_URLS = \[([\s\S]*?)\];/)?.[1] ?? '';
  assert.doesNotMatch(precacheBlock, /'\/'/);
  assert.doesNotMatch(precacheBlock, /\/orders\/new/);
  assert.doesNotMatch(precacheBlock, /\/deposit/);
  assert.doesNotMatch(precacheBlock, /\/billing/);
  assert.doesNotMatch(precacheBlock, /\/backoffice/);
});

test('las navegaciones son network-first y sólo cachean las páginas offline', () => {
  assert.match(swSource, /const NAVIGATION_TIMEOUT_MS = 4_000;/);
  assert.match(swSource, /const handleNavigation = async \(event\) =>/);
  assert.match(swSource, /const PAGE_CACHE = `sgi-page-\$\{BUILD_ID\}`;/);
  assert.match(swSource, /const OFFLINE_ORDER_PAGE = '\/orders\/new';/);
  assert.match(swSource, /cacheOfflinePage/);

  const navigationBlock =
    swSource.match(/const handleNavigation = async \(event\) => \{([\s\S]*?)\n\};/)?.[1] ?? '';
  assert.match(navigationBlock, /cacheOfflinePage/);
  assert.doesNotMatch(navigationBlock, /putInCache\(/);
  assert.match(navigationBlock, /offlineFallback/);
  assert.match(swSource, /if \(isNavigationRequest\(request\)\) \{/);

  // La función de caché sólo acepta la allowlist y comprueba el redirect.
  const cacheBlock =
    swSource.match(
      /const cacheOfflinePage = async \(request, response\) => \{([\s\S]*?)\n\};/,
    )?.[1] ?? '';
  assert.match(cacheBlock, /OFFLINE_NAVIGATION_ALLOWLIST/);
  assert.match(cacheBlock, /response\.redirected|new URL\(response\.url\)/);
  assert.match(cacheBlock, /text\/html/);
});

test('la allowlist offline incluye el alta y los catálogos', () => {
  assert.match(swSource, /const OFFLINE_ORDER_PAGE = '\/orders\/new';/);
  assert.match(swSource, /const OFFLINE_CATALOG_PAGES = \['\/catalog', '\/catalog\/clients'\];/);
  assert.match(swSource, /const OFFLINE_NAVIGATION_ALLOWLIST = new Set\(\[/);
  assert.match(swSource, /\.\.\.OFFLINE_CATALOG_PAGES/);
  assert.match(swSource, /const OFFLINE_PAGE = '\/offline';/);
  assert.match(swSource, /normalizePathname/);
});

test('sólo se cachean catálogo de productos y marcas', () => {
  assert.match(swSource, /const CATALOG_API_PATHS = \['\/api\/products', '\/api\/brands'\];/);
  assert.match(swSource, /const MAX_CATALOG_ENTRIES = 60;/);
  assert.doesNotMatch(swSource, /\/api\/clients/);
  assert.doesNotMatch(swSource, /\/api\/orders/);
  assert.doesNotMatch(swSource, /\/api\/notifications/);
  assert.doesNotMatch(swSource, /\/api\/events/);

  // Los endpoints fuera de catálogo se dejan pasar a la red sin respondWith.
  assert.match(swSource, /if \(!isCatalogApiRequest\(url\)\) return;/);
});

test('el SW no hace skipWaiting al instalar: espera el mensaje de la página', () => {
  const installBlock =
    swSource.match(/self\.addEventListener\('install'[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert.match(installBlock, /precacheStatic/);
  assert.doesNotMatch(installBlock, /self\.skipWaiting\(\)/);

  assert.match(swSource, /const SKIP_WAITING_MESSAGE = 'SKIP_WAITING';/);
  assert.match(swSource, /data\.type === SKIP_WAITING_MESSAGE/);
  assert.match(swSource, /event\.waitUntil\(self\.skipWaiting\(\)\)/);
});

test('la página avisa de la versión nueva y recarga una sola vez', () => {
  assert.match(managerSource, /Nueva versión disponible/);
  assert.match(managerSource, /Actualizar/);
  assert.match(managerSource, /postMessage\(\{ type: 'SKIP_WAITING' \}\)/);
  assert.match(managerSource, /controllerchange/);
  assert.match(managerSource, /reloadingRef\.current/);
  assert.match(managerSource, /updateViaCache: 'none'/);
});

test('el logout y el cambio de usuario limpian cachés y datos offline', () => {
  assert.match(
    userContextSource,
    /clearUserOfflineData\(\{ userId: user\?\.id, clearPendingOrders \}\)/,
  );
  assert.match(userContextSource, /previousOwner !== user\.id/);
  assert.match(userContextSource, /clearPendingOrders: true/);

  const pwaClientSource = readFileSync(new URL('../lib/pwa-client.ts', import.meta.url), 'utf8');
  assert.match(pwaClientSource, /caches\.delete/);
  assert.match(pwaClientSource, /deleteOfflineDatabase/);
  assert.match(pwaClientSource, /SERVICE_WORKER_CLEAR_MESSAGE/);
  assert.match(pwaClientSource, /clearPendingOrderRequests/);
});
