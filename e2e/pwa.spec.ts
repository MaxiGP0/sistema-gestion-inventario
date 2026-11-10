import { expect, test, type Page } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { loginAs } from './helpers';

/**
 * Suite PWA con service workers reales. Corre en el proyecto `pwa` de
 * playwright.config.ts; el resto de la suite los bloquea.
 *
 * Verifica:
 * - primera carga: el SW se registra, la caché está versionada y sólo contiene
 *   estáticos + el shell offline;
 * - recarga offline de una ruta de la allowlist (`/orders/new`);
 * - una página con datos de negocio (bandeja de depósito) nunca se sirve desde
 *   Cache Storage.
 */

async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });

  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
    // `clients.claim()` suele alcanzar; este reload cubre navegadores que
    // tardan en asignar el controller a la pestaña actual.
    await page.reload();
  }

  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), {
      timeout: 20_000,
    })
    .toBe(true);
}

test('primera carga: SW versionado y precache sólo de estáticos', async ({ page }) => {
  await loginAs(page, E2E_USERS.seller);
  await waitForServiceWorkerControl(page);

  const snapshot = await page.evaluate(async () => {
    const cacheNames = await caches.keys();
    const staticCacheName = cacheNames.find((name) => name.startsWith('sgi-static-'));
    const catalogCacheName = cacheNames.find((name) => name.startsWith('sgi-catalog-'));

    const staticUrls = staticCacheName
      ? (await (await caches.open(staticCacheName)).keys()).map((request) => {
          const url = new URL(request.url);
          return url.pathname;
        })
      : [];

    const sensitivePaths = [
      '/',
      '/orders/new',
      '/deposit/orders',
      '/billing/orders',
      '/backoffice/clients',
    ];
    const sensitiveCached = (
      await Promise.all(sensitivePaths.map((path) => caches.match(path)))
    ).some(Boolean);

    let clientsCached = false;
    for (const cacheName of cacheNames) {
      const cache = await caches.open(cacheName);
      if (await cache.match('/api/clients')) {
        clientsCached = true;
        break;
      }
    }

    return {
      cacheNames,
      staticCacheName,
      catalogCacheName,
      staticUrls,
      sensitiveCached,
      clientsCached,
    };
  });

  expect(snapshot.cacheNames.length).toBeGreaterThan(0);
  expect(snapshot.staticCacheName).toMatch(/^sgi-static-/);
  if (snapshot.catalogCacheName) {
    expect(snapshot.catalogCacheName).toMatch(/^sgi-catalog-/);
  }

  expect(snapshot.staticUrls).toEqual(
    expect.arrayContaining(['/offline', '/manifest.webmanifest', '/icons/icon-192.png']),
  );
  expect(snapshot.staticUrls).not.toContain('/');
  expect(snapshot.staticUrls).not.toContain('/orders/new');
  expect(snapshot.sensitiveCached).toBe(false);
  expect(snapshot.clientsCached).toBe(false);
});

test('recarga offline de /orders/new con el HTML del alta cacheado', async ({ page, context }) => {
  await loginAs(page, E2E_USERS.seller);
  await waitForServiceWorkerControl(page);

  await page.goto('/orders/new');
  await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();

  // El SW guarda únicamente este HTML, en la caché versionada de páginas.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          for (const cacheName of await caches.keys()) {
            const cache = await caches.open(cacheName);
            if (await cache.match('/orders/new')) return true;
          }
          return false;
        }),
      { timeout: 20_000 },
    )
    .toBe(true);

  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

  // Arranque en frío: el formulario se hidrata desde IndexedDB, no desde una
  // página de negocio arbitraria (las demás rutas siguen sin cachearse).
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Alta de pedido sin conexión' })).toHaveCount(0);

  await context.setOffline(false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();
});

test('avisa cuando hay una versión en espera y actualiza una sola vez', async ({ page }) => {
  await loginAs(page, E2E_USERS.seller);
  await waitForServiceWorkerControl(page);

  // Registrar una URL distinta simula el despliegue de un build nuevo: el SW
  // queda en `waiting` porque no hace skipWaiting al instalar.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js?v=e2e-update', { scope: '/' });
  });

  await expect(page.getByText('Nueva versión disponible')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Actualizar' }).click();

  await expect(page.getByText('Nueva versión disponible')).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Panel vendedor' })).toBeVisible();
});

test('logout limpia catálogo, borradores y la marca de usuario offline', async ({ page }) => {
  await loginAs(page, E2E_USERS.seller);
  await waitForServiceWorkerControl(page);

  // Poblar la caché de catálogo a través del SW.
  await page.evaluate(async () => {
    await fetch('/api/products');
    await fetch('/api/brands');
  });
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          (await caches.keys()).some((name) => name.startsWith('sgi-catalog-')),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);

  await page.evaluate(() => {
    localStorage.setItem('sgi_order_draft:e2e', '{"quantities":{}}');
  });

  // Snapshot de catálogo offline: debe desaparecer con el logout.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('sgi-offline-catalog');
        request.onupgradeneeded = () => {
          request.result.createObjectStore('clients', { keyPath: 'key' });
        };
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
  );
  expect(
    await page.evaluate(async () =>
      (await indexedDB.databases()).some((database) => database.name === 'sgi-offline-catalog'),
    ),
  ).toBe(true);

  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Ingresar al sistema' })).toBeVisible();

  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          (await caches.keys()).some((name) => name.startsWith('sgi-catalog-')),
        ),
      { timeout: 15_000 },
    )
    .toBe(false);

  expect(await page.evaluate(() => localStorage.getItem('sgi_offline_owner'))).toBeNull();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('sgi_order_draft:')),
    ),
  ).toEqual([]);
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          (await indexedDB.databases()).some((database) => database.name === 'sgi-offline-catalog'),
        ),
      { timeout: 15_000 },
    )
    .toBe(false);
});

test('una bandeja con datos de negocio no se sirve desde caché al estar offline', async ({
  page,
  context,
}) => {
  await loginAs(page, E2E_USERS.deposit);
  await waitForServiceWorkerControl(page);

  await page.goto('/deposit/orders');
  await expect(page.getByRole('heading', { name: 'Pedidos Pendientes de Picking' })).toBeVisible();

  // La respuesta de la bandeja no debe quedar en ninguna caché.
  const cachedTray = await page.evaluate(async () => {
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      if (await cache.match('/deposit/orders')) return true;
    }
    return false;
  });
  expect(cachedTray).toBe(false);

  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Sin conexión' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pedidos Pendientes de Picking' })).toHaveCount(0);

  await context.setOffline(false);
});
