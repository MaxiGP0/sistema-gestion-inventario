/**
 * Pruebas del catálogo offline (lib/offline-catalog.ts) con IndexedDB real
 * emulada por `fake-indexeddb`:
 * - formato de registros (`key`, `userId`, `savedAt`) y límites por dataset;
 * - aislamiento estricto entre usuarios;
 * - TTL vencido => snapshot no fresco (la UI fuerza refresh);
 * - búsqueda local por nombre/código, tolerante a acentos;
 * - recientes/frecuentes acotados a 5;
 * - limpieza por usuario y borrado total en logout.
 *
 * Ejecutar con: npm test
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';

import {
  buildOfflineCatalogConfig,
  clearOfflineCatalogForUser,
  closeOfflineCatalogDatabase,
  deleteOfflineCatalogDatabase,
  OFFLINE_CATALOG_DB_NAME,
  OFFLINE_CATALOG_DB_VERSION,
  OFFLINE_CATALOG_DEFAULT_LIMITS,
  OFFLINE_CATALOG_DEFAULT_TTL_MS,
  OFFLINE_CATALOG_STORE_NAMES,
  offlineCatalogRecordKey,
  readOfflineCatalogBrands,
  readOfflineCatalogClients,
  readOfflineCatalogMeta,
  readOfflineCatalogProducts,
  readOfflineRecentClients,
  recordOfflineRecentClient,
  searchOfflineCatalogClients,
  searchOfflineCatalogProducts,
  writeOfflineCatalogBrands,
  writeOfflineCatalogClients,
  writeOfflineCatalogProducts,
  type OfflineCatalogClient,
} from '../lib/offline-catalog';
import {
  prefetchOfflineCatalogClients,
  prefetchOfflineCatalogProducts,
  rememberOfflineCatalogClients,
  rememberOfflineCatalogProducts,
} from '../lib/offline-catalog-sync';
import type { BrandDTO, ProductDTO } from '../lib/types';

const USER_A = 'user-a';
const USER_B = 'user-b';
const DAY = 24 * 60 * 60 * 1_000;

const makeClient = (id: string, code: string, name: string): OfflineCatalogClient => ({
  _id: id,
  code,
  name,
  address: 'Calle 123',
  localidad: 'CABA',
  province: 'Buenos Aires',
  generalDiscount: 5,
  brandDiscounts: [],
});

const makeProduct = (id: string, code: string, name: string, brandId = 'brand-1'): ProductDTO => ({
  _id: id,
  code,
  name,
  price: 1_000,
  priceWithIva: 1_210,
  brandId: { _id: brandId, name: brandId === 'brand-1' ? 'Marca Uno' : 'Marca Dos' },
});

const makeBrand = (id: string, name: string): BrandDTO => ({ _id: id, name });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** Reemplaza `fetch` para probar el prefetch sin servidor. */
function stubFetch(
  t: { after: (fn: () => void) => void },
  factory: (url: string, init?: RequestInit) => Response | Promise<Response>,
): FetchCall[] {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return factory(url, init);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return calls;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail(message);
}

beforeEach(async () => {
  await deleteOfflineCatalogDatabase();
});

test('el formato v1 define los cinco stores y claves aisladas por usuario', () => {
  assert.equal(OFFLINE_CATALOG_DB_NAME, 'sgi-offline-catalog');
  assert.equal(OFFLINE_CATALOG_DB_VERSION, 1);
  assert.deepEqual(Object.values(OFFLINE_CATALOG_STORE_NAMES).sort(), [
    'brands',
    'clients',
    'meta',
    'products',
    'recentClients',
  ]);
  assert.equal(offlineCatalogRecordKey('u1', 'c1'), 'u1:c1');
});

test('los TTL y límites por defecto son los documentados y se pueden ajustar', () => {
  assert.equal(OFFLINE_CATALOG_DEFAULT_TTL_MS.clients, 7 * DAY);
  assert.equal(OFFLINE_CATALOG_DEFAULT_TTL_MS.products, 7 * DAY);
  assert.equal(OFFLINE_CATALOG_DEFAULT_TTL_MS.brands, 30 * DAY);
  assert.equal(OFFLINE_CATALOG_DEFAULT_LIMITS.clients, 500);
  assert.equal(OFFLINE_CATALOG_DEFAULT_LIMITS.products, 500);
  assert.equal(OFFLINE_CATALOG_DEFAULT_LIMITS.recentClients, 5);

  const custom = buildOfflineCatalogConfig({
    ttlMs: { clients: 1_000 },
    limits: { clients: 10, products: 20, recentClients: 3 },
  });
  assert.equal(custom.ttlMs.clients, 1_000);
  assert.equal(custom.ttlMs.products, 7 * DAY);
  assert.equal(custom.limits.clients, 10);
  assert.equal(custom.limits.products, 20);
  assert.equal(custom.limits.recentClients, 3);
  assert.equal(custom.limits.brands, 500);
});

test('guarda clientes, marcas y productos con userId/savedAt y sobrevive a reabrir', async () => {
  const before = Date.now();
  await writeOfflineCatalogClients(USER_A, [makeClient('c1', 'CLI-1', 'Farmacia Uno')]);
  await writeOfflineCatalogBrands(USER_A, [makeBrand('brand-1', 'Marca Uno')]);
  await writeOfflineCatalogProducts(USER_A, [makeProduct('p1', 'PROD-1', 'Producto Uno')]);

  await closeOfflineCatalogDatabase();

  const [clients, brands, products, meta] = await Promise.all([
    readOfflineCatalogClients(USER_A),
    readOfflineCatalogBrands(USER_A),
    readOfflineCatalogProducts(USER_A),
    readOfflineCatalogMeta(USER_A),
  ]);

  assert.equal(clients.items[0]._id, 'c1');
  assert.equal(brands.items[0]._id, 'brand-1');
  assert.equal(products.items[0]._id, 'p1');
  assert.ok(clients.savedAt !== null && clients.savedAt >= before);
  assert.equal(clients.fresh, true);
  assert.equal(meta.clients?.savedAt, clients.savedAt);
  assert.equal(meta.products?.count, 1);

  // El registro físico incluye los campos de aislamiento.
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_CATALOG_DB_NAME, OFFLINE_CATALOG_DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const record = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_CATALOG_STORE_NAMES.clients, 'readonly');
    const request = tx.objectStore(OFFLINE_CATALOG_STORE_NAMES.clients).get('user-a:c1');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();

  assert.equal(record.key, 'user-a:c1');
  assert.equal(record.userId, 'user-a');
  assert.equal(typeof record.savedAt, 'number');
});

test('los datos de un usuario no se ven desde otro', async () => {
  await writeOfflineCatalogClients(USER_A, [makeClient('a1', 'CLI-A', 'Cliente de A')]);
  await writeOfflineCatalogClients(USER_B, [makeClient('b1', 'CLI-B', 'Cliente de B')]);
  await writeOfflineCatalogProducts(USER_A, [makeProduct('pa', 'PROD-A', 'Producto de A')]);
  await writeOfflineCatalogProducts(USER_B, [makeProduct('pb', 'PROD-B', 'Producto de B')]);
  await recordOfflineRecentClient(USER_A, makeClient('a1', 'CLI-A', 'Cliente de A'));

  const [clientsA, clientsB, productsA, recentA, recentB] = await Promise.all([
    searchOfflineCatalogClients(USER_A, ''),
    searchOfflineCatalogClients(USER_B, ''),
    searchOfflineCatalogProducts(USER_A, ''),
    readOfflineRecentClients(USER_A),
    readOfflineRecentClients(USER_B),
  ]);

  assert.deepEqual(
    clientsA.items.map((client) => client._id),
    ['a1'],
  );
  assert.deepEqual(
    clientsB.items.map((client) => client._id),
    ['b1'],
  );
  assert.deepEqual(
    productsA.items.map((product) => product._id),
    ['pa'],
  );
  assert.deepEqual(
    recentA.items.map((client) => client._id),
    ['a1'],
  );
  assert.deepEqual(recentB.items, []);
});

test('al vencer el TTL el snapshot deja de ser fresco y no devuelve datos', async () => {
  const shortTtl = buildOfflineCatalogConfig({
    ttlMs: { clients: 2, products: 2 },
  });

  await writeOfflineCatalogClients(USER_A, [makeClient('c1', 'CLI-1', 'Vencido')], shortTtl);
  await writeOfflineCatalogProducts(USER_A, [makeProduct('p1', 'PROD-1', 'Vencido')], shortTtl);

  await sleep(15);

  const [clients, products, search] = await Promise.all([
    readOfflineCatalogClients(USER_A, shortTtl),
    readOfflineCatalogProducts(USER_A, shortTtl),
    searchOfflineCatalogClients(USER_A, 'vencido', { config: shortTtl }),
  ]);

  assert.equal(clients.fresh, false);
  assert.equal(clients.expired, 1);
  assert.deepEqual(clients.items, []);
  assert.equal(products.fresh, false);
  assert.deepEqual(products.items, []);
  assert.equal(search.total, 0);

  // Una revalidación (escritura nueva) descarta lo vencido y vuelve a dejar
  // el snapshot fresco.
  await writeOfflineCatalogClients(USER_A, [makeClient('c2', 'CLI-2', 'Actualizado')], shortTtl);
  const refreshed = await readOfflineCatalogClients(USER_A, shortTtl);
  assert.equal(refreshed.fresh, true);
  assert.deepEqual(
    refreshed.items.map((client) => client._id),
    ['c2'],
  );
});

test('la búsqueda local encuentra por nombre y código sin distinguir acentos', async () => {
  await writeOfflineCatalogClients(USER_A, [
    makeClient('c1', 'CLI-100', 'Farmacia Ñandú'),
    makeClient('c2', 'CLI-200', 'Farmacia del Pueblo'),
  ]);

  const [byName, byAccent, byCode, byAddress, missing] = await Promise.all([
    searchOfflineCatalogClients(USER_A, 'pueblo'),
    searchOfflineCatalogClients(USER_A, 'nandu'),
    searchOfflineCatalogClients(USER_A, 'CLI-100'),
    searchOfflineCatalogClients(USER_A, 'calle 123'),
    searchOfflineCatalogClients(USER_A, 'inexistente'),
  ]);

  assert.deepEqual(
    byName.items.map((client) => client._id),
    ['c2'],
  );
  assert.deepEqual(
    byAccent.items.map((client) => client._id),
    ['c1'],
  );
  assert.deepEqual(
    byCode.items.map((client) => client._id),
    ['c1'],
  );
  assert.equal(byAddress.total, 2);
  assert.equal(missing.total, 0);
});

test('la búsqueda local de productos exige todos los tokens en cualquier posición', async () => {
  await writeOfflineCatalogProducts(USER_A, [
    makeProduct('p1', 'SH-400', 'Shampoo Capitalis 400ml'),
    makeProduct('p2', 'SH-200', 'Shampoo Capitalis 200ml'),
  ]);

  const [byTokens, bySecondWord, missing] = await Promise.all([
    searchOfflineCatalogProducts(USER_A, 'shampoo 400'),
    searchOfflineCatalogProducts(USER_A, 'capitalis'),
    searchOfflineCatalogProducts(USER_A, 'shampoo 500'),
  ]);

  assert.deepEqual(
    byTokens.items.map((product) => product._id),
    ['p1'],
  );
  assert.deepEqual(
    bySecondWord.items.map((product) => product._id),
    ['p2', 'p1'],
  );
  assert.equal(missing.total, 0);
});

test('la consulta local pagina productos y clientes sin depender del servidor', async () => {
  await writeOfflineCatalogProducts(USER_A, [
    makeProduct('p1', 'PROD-1', 'Producto Uno', 'brand-1'),
    makeProduct('p2', 'PROD-2', 'Producto Dos', 'brand-2'),
    makeProduct('p3', 'PROD-3', 'Producto Tres', 'brand-1'),
  ]);
  await writeOfflineCatalogClients(USER_A, [
    makeClient('c1', 'CLI-1', 'Cliente Uno'),
    makeClient('c2', 'CLI-2', 'Cliente Dos'),
    makeClient('c3', 'CLI-3', 'Cliente Tres'),
  ]);

  const [productPageOne, productPageTwo, clientPageOne, clientPageTwo] = await Promise.all([
    searchOfflineCatalogProducts(USER_A, '', { limit: 2, offset: 0 }),
    searchOfflineCatalogProducts(USER_A, '', { limit: 2, offset: 2 }),
    searchOfflineCatalogClients(USER_A, '', { limit: 2, offset: 0 }),
    searchOfflineCatalogClients(USER_A, '', { limit: 2, offset: 2 }),
  ]);

  assert.equal(productPageOne.total, 3);
  assert.equal(productPageOne.items.length, 2);
  assert.equal(productPageTwo.items.length, 1);
  assert.equal(clientPageOne.total, 3);
  assert.equal(clientPageOne.items.length, 2);
  assert.equal(clientPageTwo.items.length, 1);

  // El filtro por marca se combina con la búsqueda y la paginación local.
  const brandPage = await searchOfflineCatalogProducts(USER_A, '', {
    brandId: 'brand-1',
    limit: 1,
    offset: 1,
  });
  assert.equal(brandPage.total, 2);
  assert.equal(brandPage.items.length, 1);
  assert.equal(brandPage.items[0]._id, 'p3');
});

test('la búsqueda de productos filtra por marca y respeta el tope del snapshot', async () => {
  const limited = buildOfflineCatalogConfig({ limits: { products: 2 } });

  await writeOfflineCatalogProducts(
    USER_A,
    [
      makeProduct('p1', 'PROD-1', 'Analgésico', 'brand-1'),
      makeProduct('p2', 'PROD-2', 'Antiinflamatorio', 'brand-2'),
      makeProduct('p3', 'PROD-3', 'Analgésico fuerte', 'brand-1'),
    ],
    limited,
  );

  const [brandOne, keptProduct, droppedProduct, stored] = await Promise.all([
    searchOfflineCatalogProducts(USER_A, '', { brandId: 'brand-1', config: limited }),
    searchOfflineCatalogProducts(USER_A, 'prod-2', { config: limited }),
    searchOfflineCatalogProducts(USER_A, 'prod-3', { config: limited }),
    readOfflineCatalogProducts(USER_A, limited),
  ]);

  assert.deepEqual(
    brandOne.items.map((product) => product._id),
    ['p1'],
  );
  assert.equal(keptProduct.total, 1, 'p2 entra en el tope de 2 registros');
  assert.equal(droppedProduct.total, 0, 'p3 queda fuera por el tope');
  assert.equal(stored.items.length, 2);
});

test('el prefetch completa productos aunque ya existan los 50 iniciales del SSR', async (t) => {
  const config = buildOfflineCatalogConfig({ limits: { products: 500 } });
  const serverProducts = Array.from({ length: 600 }, (_, index) =>
    makeProduct(
      `prefetch-product-${index + 1}`,
      `PRE-${index + 1}`,
      `Producto prefetch ${index + 1}`,
    ),
  );

  // El montaje escribe la primera página (50) y su meta parcial. Antes eso
  // bloqueaba el prefetch; ahora sólo una sincronización completa lo hace.
  rememberOfflineCatalogProducts(USER_A, serverProducts.slice(0, 50), config);
  await waitFor(
    async () => (await readOfflineCatalogProducts(USER_A, config)).items.length === 50,
    'la escritura parcial inicial no terminó',
  );
  const partialMeta = await readOfflineCatalogMeta(USER_A, config);
  assert.equal(partialMeta.products?.count, 50);
  assert.equal(partialMeta.products?.fullSyncAt, undefined);

  const calls = stubFetch(t, (input) => {
    const url = new URL(String(input), 'http://localhost');
    const page = Number(url.searchParams.get('page') ?? '1');
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const start = (page - 1) * limit;
    const products = serverProducts.slice(start, start + limit);

    return jsonResponse({
      success: true,
      products,
      total: serverProducts.length,
      page,
      limit,
      totalPages: Math.ceil(serverProducts.length / limit),
      hasMore: start + products.length < serverProducts.length,
    });
  });

  const startedAt = Date.now();
  const fetched = await prefetchOfflineCatalogProducts(USER_A, config);

  assert.equal(fetched.length, 500, 'el prefetch debe completar el tope de 500');
  assert.deepEqual(
    calls.map((call) => new URL(call.url, 'http://localhost').searchParams.get('limit')),
    ['200', '200', '200'],
  );

  const stored = await readOfflineCatalogProducts(USER_A, config);
  assert.equal(stored.items.length, 500);

  const meta = await readOfflineCatalogMeta(USER_A, config);
  assert.equal(meta.products?.count, 500);
  assert.equal(typeof meta.products?.fullSyncAt, 'number');
  assert.ok((meta.products?.fullSyncAt ?? 0) >= startedAt);
  const fullSyncAt = meta.products?.fullSyncAt;

  // Una escritura parcial posterior conserva el sello de sincronización.
  rememberOfflineCatalogProducts(
    USER_A,
    [makeProduct('partial-extra', 'PRE-EXTRA', 'Producto parcial extra')],
    config,
  );
  await waitFor(
    async () =>
      (await readOfflineCatalogProducts(USER_A, config)).items.some(
        (product) => product._id === 'partial-extra',
      ),
    'la escritura parcial posterior no terminó',
  );
  const afterPartial = await readOfflineCatalogMeta(USER_A, config);
  assert.equal(afterPartial.products?.fullSyncAt, fullSyncAt);

  // Con fullSyncAt vigente, otra visita no vuelve a pedir el catálogo.
  const callsBeforeSecondRun = calls.length;
  const secondRun = await prefetchOfflineCatalogProducts(USER_A, config);
  assert.deepEqual(secondRun, []);
  assert.equal(calls.length, callsBeforeSecondRun);
});

test('el prefetch completa clientes en lotes de hasta 200 hasta el tope de 500', async (t) => {
  const config = buildOfflineCatalogConfig({ limits: { clients: 500 } });
  const serverClients = Array.from({ length: 600 }, (_, index) =>
    makeClient(`prefetch-client-${index + 1}`, `PRE-CLI-${index + 1}`, `Cliente ${index + 1}`),
  );

  rememberOfflineCatalogClients(USER_A, serverClients.slice(0, 50), config);
  await waitFor(
    async () => (await readOfflineCatalogClients(USER_A, config)).items.length === 50,
    'la escritura parcial inicial de clientes no terminó',
  );
  const partialMeta = await readOfflineCatalogMeta(USER_A, config);
  assert.equal(partialMeta.clients?.count, 50);
  assert.equal(partialMeta.clients?.fullSyncAt, undefined);

  const calls = stubFetch(t, (input) => {
    const url = new URL(String(input), 'http://localhost');
    const page = Number(url.searchParams.get('page') ?? '1');
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const start = (page - 1) * limit;
    const clients = serverClients.slice(start, start + limit);

    return jsonResponse({
      success: true,
      clients,
      total: serverClients.length,
      page,
      limit,
      totalPages: Math.ceil(serverClients.length / limit),
    });
  });

  const startedAt = Date.now();
  const fetched = await prefetchOfflineCatalogClients(USER_A, config);

  assert.equal(fetched.length, 500, 'el prefetch debe completar el tope de 500');
  assert.deepEqual(
    calls.map((call) => new URL(call.url, 'http://localhost').searchParams.get('limit')),
    ['200', '200', '200'],
  );

  const stored = await readOfflineCatalogClients(USER_A, config);
  assert.equal(stored.items.length, 500);

  const meta = await readOfflineCatalogMeta(USER_A, config);
  assert.equal(meta.clients?.count, 500);
  assert.equal(typeof meta.clients?.fullSyncAt, 'number');
  assert.ok((meta.clients?.fullSyncAt ?? 0) >= startedAt);

  const callsBeforeSecondRun = calls.length;
  const secondRun = await prefetchOfflineCatalogClients(USER_A, config);
  assert.deepEqual(secondRun, []);
  assert.equal(calls.length, callsBeforeSecondRun);
});

test('los clientes recientes se ordenan por frecuencia, se limitan a 5 y no se mezclan', async () => {
  const config = buildOfflineCatalogConfig({ limits: { recentClients: 5 } });
  const clients = Array.from({ length: 6 }, (_, index) =>
    makeClient(`c${index + 1}`, `CLI-${index + 1}`, `Cliente ${index + 1}`),
  );

  // Se cargan primero cinco para que el tope no expire al cliente que luego
  // se usa más veces por una diferencia de milisegundos entre llamadas.
  for (const client of clients.slice(0, 5)) {
    await recordOfflineRecentClient(USER_A, client, config);
  }

  // Frecuencia: c1 se usa 3 veces y c2 dos veces. El sexto cliente comprueba
  // que la lista se recorta a 5 sin importar el orden de los empates.
  await recordOfflineRecentClient(USER_A, clients[0], config);
  await recordOfflineRecentClient(USER_A, clients[0], config);
  await recordOfflineRecentClient(USER_A, clients[1], config);
  await recordOfflineRecentClient(USER_A, clients[5], config);

  const recent = await readOfflineRecentClients(USER_A, config);
  assert.equal(recent.items.length, 5);
  assert.deepEqual(
    recent.items.slice(0, 2).map((client) => client._id),
    ['c1', 'c2'],
  );
  assert.equal(new Set(recent.items.map((client) => client._id)).size, 5);

  const otherUser = await readOfflineRecentClients(USER_B, config);
  assert.deepEqual(otherUser.items, []);
});

test('limpiar un usuario no toca al otro y el borrado total vacía la base', async () => {
  await writeOfflineCatalogClients(USER_A, [makeClient('a1', 'CLI-A', 'A')]);
  await writeOfflineCatalogClients(USER_B, [makeClient('b1', 'CLI-B', 'B')]);
  await writeOfflineCatalogProducts(USER_A, [makeProduct('pa', 'PROD-A', 'A')]);

  await clearOfflineCatalogForUser(USER_A);

  const [clientsA, clientsB, productsA] = await Promise.all([
    readOfflineCatalogClients(USER_A),
    readOfflineCatalogClients(USER_B),
    readOfflineCatalogProducts(USER_A),
  ]);
  assert.deepEqual(clientsA.items, []);
  assert.deepEqual(productsA.items, []);
  assert.deepEqual(
    clientsB.items.map((client) => client._id),
    ['b1'],
  );

  await deleteOfflineCatalogDatabase();
  const afterDelete = await readOfflineCatalogClients(USER_B);
  assert.deepEqual(afterDelete.items, []);
});

test('logout y service worker borran el catálogo offline junto con las cachés', () => {
  const pwaClient = readFileSync(new URL('../lib/pwa-client.ts', import.meta.url), 'utf8');
  const userContext = readFileSync(new URL('../context/UserContext.tsx', import.meta.url), 'utf8');
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

  assert.match(pwaClient, /deleteOfflineCatalogDatabase\(\)/);
  assert.match(pwaClient, /clearServiceWorkerCaches\(\)/);
  assert.match(pwaClient, /clearPendingOrderRequests/);
  assert.match(userContext, /clearUserOfflineData\(\{ userId: user\?\.id, clearPendingOrders \}\)/);
  assert.match(userContext, /previousOwner !== user\.id/);

  // El SW cachea sólo las rutas capaces de hidratar desde IndexedDB.
  assert.match(sw, /const PAGE_CACHE = `sgi-page-\$\{BUILD_ID\}`;/);
  assert.match(sw, /const OFFLINE_ORDER_PAGE = '\/orders\/new';/);
  assert.match(sw, /const OFFLINE_CATALOG_PAGES = \['\/catalog', '\/catalog\/clients'\];/);
  assert.match(sw, /const OFFLINE_NAVIGATION_ALLOWLIST = new Set\(\[/);
  assert.match(sw, /cacheOfflinePage/);
  assert.match(sw, /caches\.match\(pathname, \{ cacheName: PAGE_CACHE \}\)/);
  assert.match(sw, /CLEAR_USER_CACHES_MESSAGE/);
});
