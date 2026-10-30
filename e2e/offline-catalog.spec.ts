import { expect, test, type Page } from '@playwright/test';
import { E2E_CLIENTS, E2E_PRODUCTS, E2E_USERS } from './fixtures';
import { loginAs, openDepositOrder } from './helpers';

/**
 * Alta de pedidos en frío con el catálogo guardado en IndexedDB.
 *
 * Corre en el proyecto Playwright `pwa` porque necesita service workers reales:
 * el SW cachea el HTML de `/orders/new` y, al recargar sin red, React hidrata y
 * lee clientes/productos desde IndexedDB.
 */

const CACHE_DB = 'sgi-offline-catalog';
const QUEUE_DB = 'sgi-offline';

interface CachedClientSeed {
  _id: string;
  code: string;
  name: string;
}

async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });

  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
    await page.reload();
  }

  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), {
      timeout: 20_000,
    })
    .toBe(true);
}

async function waitForOfflinePageCache(page: Page, path: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (cachedPath) => {
          for (const cacheName of await caches.keys()) {
            const cache = await caches.open(cacheName);
            if (await cache.match(cachedPath)) return true;
          }
          return false;
        }, path),
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** Cantidad de registros del snapshot para un store (`clients`/`products`). */
async function countCachedCatalogRecords(
  page: Page,
  storeName: 'clients' | 'products',
): Promise<number> {
  return page.evaluate(
    ({ dbName, store }) =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            resolve(0);
            return;
          }
          const tx = db.transaction(store, 'readonly');
          const count = tx.objectStore(store).count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => {
            db.close();
            reject(count.error);
          };
        };
        request.onerror = () => reject(request.error);
      }),
    { dbName: CACHE_DB, store: storeName },
  );
}

async function sessionUserId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch('/api/auth/session');
    const payload = (await response.json()) as { user: { id: string } };
    return payload.user.id;
  });
}

async function waitForCatalogDb(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (dbName) => {
          const databases = await indexedDB.databases();
          return databases.some((database) => database.name === dbName);
        }, CACHE_DB),
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** Siembra las stores con el mismo formato que lib/offline-catalog.ts. */
async function seedCatalog(
  page: Page,
  userId: string,
  input: {
    client: CachedClientSeed;
    product: { _id: string; code: string; name: string; price: number };
    brand: { _id: string; name: string };
    savedAt?: number;
  },
): Promise<void> {
  await page.evaluate(
    async ({ dbName, userId, client, product, brand, savedAt }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          for (const storeName of ['clients', 'brands', 'products', 'recentClients', 'meta']) {
            if (database.objectStoreNames.contains(storeName)) continue;
            const store = database.createObjectStore(storeName, { keyPath: 'key' });
            store.createIndex('userId', 'userId', { unique: false });
            if (storeName === 'recentClients') {
              store.createIndex('lastUsedAt', 'lastUsedAt', { unique: false });
            }
            if (storeName === 'meta') {
              store.createIndex('dataset', 'dataset', { unique: false });
            }
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      const clientRecord = {
        key: `${userId}:${client._id}`,
        userId,
        id: client._id,
        savedAt,
        data: {
          ...client,
          address: 'Calle Falsa 123',
          localidad: 'CABA',
          province: 'Buenos Aires',
          generalDiscount: 0,
          brandDiscounts: [],
        },
      };
      const brandRecord = {
        key: `${userId}:${brand._id}`,
        userId,
        id: brand._id,
        savedAt,
        data: brand,
      };
      const productRecord = {
        key: `${userId}:${product._id}`,
        userId,
        id: product._id,
        savedAt,
        data: {
          ...product,
          priceWithIva: product.price * 1.21,
          brandId: brand,
        },
      };

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['clients', 'brands', 'products'], 'readwrite');
        tx.objectStore('clients').put(clientRecord);
        tx.objectStore('brands').put(brandRecord);
        tx.objectStore('products').put(productRecord);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });

      db.close();
    },
    {
      dbName: CACHE_DB,
      userId,
      client: input.client,
      product: input.product,
      brand: input.brand,
      savedAt: input.savedAt ?? Date.now(),
    },
  );
}

async function countQueuedOrders(page: Page): Promise<number> {
  return page.evaluate(
    (dbName) =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('order-queue')) {
            db.close();
            resolve(0);
            return;
          }
          const tx = db.transaction('order-queue', 'readonly');
          const count = tx.objectStore('order-queue').count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => {
            db.close();
            reject(count.error);
          };
        };
        request.onerror = () => reject(request.error);
      }),
    QUEUE_DB,
  );
}

test.describe('Catálogo offline del alta', () => {
  test('con IndexedDB sembrada y sin red muestra cliente/producto y encola el pedido', async ({
    page,
    context,
  }) => {
    await loginAs(page, E2E_USERS.seller);

    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();
    await waitForServiceWorkerControl(page);
    await waitForCatalogDb(page);

    const userId = await sessionUserId(page);
    const client = { _id: 'offline-client-1', code: 'E2E-CACHE-CLI', name: 'Farmacia Caché Frío' };
    const product = {
      _id: 'offline-product-1',
      code: 'E2E-CACHE-PROD',
      name: 'Producto Caché Frío',
      price: 1_000,
    };
    const brand = { _id: 'offline-brand-1', name: 'Marca Caché' };

    await seedCatalog(page, userId, { client, product, brand });
    await waitForOfflinePageCache(page, '/orders/new');

    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

    // Recarga en frío: el SW sirve el HTML cacheado y la isla hidrata desde IDB.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();
    await expect(page.getByTestId('offline-catalog-badge')).toBeVisible();

    const clientSearch = page.getByPlaceholder('Buscar cliente...');
    await clientSearch.click();
    await clientSearch.fill(client.code);
    await expect(page.getByText(`${client.code} - ${client.name}`, { exact: true })).toBeVisible();
    await page.getByText(`${client.code} - ${client.name}`, { exact: true }).click();

    // Al elegirlo se actualiza la lista de recientes del usuario.
    await expect(page.getByTestId('recent-clients')).toContainText(client.code);

    const productSearch = page.getByPlaceholder('Buscar producto por nombre o código...');
    await productSearch.fill(product.code);

    const row = page.getByRole('row', { name: new RegExp(product.code) });
    await expect(row).toBeVisible();
    await row.getByRole('spinbutton', { name: /^Cantidad en el catálogo de/ }).fill('2');

    await page.getByLabel('Tipo de factura').filter({ visible: true }).selectOption('A');
    await page.getByLabel('Condición de pago').filter({ visible: true }).selectOption('contado');

    await page.getByRole('button', { name: 'Guardar Pedido (Borrador)' }).click();

    await expect(page.getByTestId('offline-order-pending')).toBeVisible();
    await expect(page.getByText('Pendiente de sincronizar', { exact: true })).toBeVisible();
    await expect.poll(() => countQueuedOrders(page)).toBe(1);

    await context.setOffline(false);
  });

  test('catálogo y clientes offline buscan en IndexedDB y permiten crear pedido con el cliente elegido', async ({
    page,
    context,
  }) => {
    const client = E2E_CLIENTS.fullFlow;
    const product = E2E_PRODUCTS.primary;

    await loginAs(page, E2E_USERS.seller);
    await waitForServiceWorkerControl(page);

    // Visitar las rutas online deja su HTML en PAGE_CACHE y precalienta el
    // snapshot de catálogo en IndexedDB.
    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();
    await waitForOfflinePageCache(page, '/orders/new');

    await page.goto('/catalog');
    await expect(page.getByRole('heading', { name: 'Catálogo de Productos' })).toBeVisible();
    await waitForOfflinePageCache(page, '/catalog');
    await expect.poll(() => countCachedCatalogRecords(page, 'products')).toBeGreaterThan(0);

    await page.goto('/catalog/clients');
    await expect(page.getByRole('heading', { name: 'Catálogo de Clientes' })).toBeVisible();
    await waitForOfflinePageCache(page, '/catalog/clients');
    await expect.poll(() => countCachedCatalogRecords(page, 'clients')).toBeGreaterThan(0);

    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

    // Recarga en frío del catálogo de productos desde el HTML cacheado.
    await page.goto('/catalog', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Catálogo de Productos' })).toBeVisible();
    await expect(page.getByTestId('offline-catalog-badge')).toBeVisible();

    const productSearch = page.getByPlaceholder('Buscar por código o nombre...');
    await productSearch.fill(product.code);
    const productTable = page.getByRole('table');
    await expect(productTable.getByText(product.name)).toBeVisible();
    await expect(productTable.getByText(product.code)).toBeVisible();

    // Recarga en frío del catálogo de clientes y búsqueda local.
    await page.goto('/catalog/clients', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Catálogo de Clientes' })).toBeVisible();
    await expect(page.getByTestId('offline-catalog-badge')).toBeVisible();

    const clientSearch = page.getByPlaceholder(
      'Buscar por código, nombre, dirección o localidad...',
    );
    await clientSearch.fill(client.code);
    const clientTable = page.getByRole('table');
    await expect(clientTable.getByText(client.name, { exact: true })).toBeVisible();

    // El botón directo abre el alta con el cliente ya seleccionado desde IDB.
    await page.getByRole('button', { name: 'Crear pedido' }).first().click();
    await expect(page).toHaveURL(/\/orders\/new\?clientId=[a-f0-9]{24}$/);
    await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();
    await expect(page.getByPlaceholder(`${client.code} - ${client.name}`).first()).toBeVisible();

    await context.setOffline(false);
  });

  test('un snapshot vencido no se muestra y al volver la red se revalida', async ({
    page,
    context,
  }) => {
    await loginAs(page, E2E_USERS.seller);

    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();
    await waitForServiceWorkerControl(page);
    await waitForCatalogDb(page);

    const userId = await sessionUserId(page);
    const expiredAt = Date.now() - 8 * 24 * 60 * 60 * 1_000;
    const client = { _id: 'expired-client-1', code: 'E2E-EXPIRED-CLI', name: 'Cliente Vencido' };
    const product = {
      _id: 'expired-product-1',
      code: 'E2E-EXPIRED-PROD',
      name: 'Producto Vencido',
      price: 500,
    };
    const brand = { _id: 'expired-brand-1', name: 'Marca Vencida' };

    await seedCatalog(page, userId, { client, product, brand, savedAt: expiredAt });
    await waitForOfflinePageCache(page, '/orders/new');

    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();

    const clientSearch = page.getByPlaceholder('Buscar cliente...');
    await clientSearch.click();
    await clientSearch.fill(client.code);
    await expect(page.getByText('No se encontraron clientes.')).toBeVisible();
    await expect(page.getByText(client.name)).toHaveCount(0);

    const productSearch = page.getByPlaceholder('Buscar producto por nombre o código...');
    await productSearch.fill(product.code);
    await expect(page.getByText(/No se encontraron productos con ese criterio/)).toBeVisible();
    await expect(page.getByText(product.name)).toHaveCount(0);

    // Al recuperar la conexión el evento online fuerza la revalidación en red.
    const clientRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/clients') clientRequests.push(request.url());
    });

    await context.setOffline(false);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await expect.poll(() => clientRequests.length, { timeout: 20_000 }).toBeGreaterThan(0);
  });

  test('el modal de agregar producto de depósito busca en IndexedDB sin red', async ({
    page,
    context,
  }) => {
    await loginAs(page, E2E_USERS.deposit);
    await openDepositOrder(page, E2E_CLIENTS.dashboard.name);

    const userId = await sessionUserId(page);
    const product = {
      _id: 'deposit-cached-product',
      code: 'E2E-DEPOSIT-CACHE',
      name: 'Producto Depósito Caché',
      price: 750,
    };
    const brand = { _id: 'deposit-cached-brand', name: 'Marca Depósito Caché' };

    await seedCatalog(page, userId, {
      client: { _id: 'deposit-client', code: 'E2E-DEP-CLI', name: 'Cliente Depósito' },
      product,
      brand,
    });

    await page.getByRole('button', { name: 'Agregar Producto' }).click();
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

    const search = page.getByPlaceholder('Buscar por código o nombre...');
    await search.fill(product.code);

    await expect(page.getByTestId('offline-catalog-badge')).toBeVisible();
    await expect(page.getByText(new RegExp(product.code))).toBeVisible();
    await expect(page.getByText(product.name)).toBeVisible();

    await context.setOffline(false);
  });
});
