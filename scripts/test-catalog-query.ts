/**
 * Pruebas de la capa de consultas del catálogo:
 * - `createLatestRequest`: el tipeo rápido aborta la consulta anterior y el id
 *   descarta cualquier respuesta que llegue tarde.
 * - `getCatalog`: TTL por recurso, deduplicación de promesas en vuelo,
 *   cancelación real del fetch compartido y reutilización al abrir/cerrar un
 *   selector.
 * - Invalidación al mutar y revalidación al volver a foco.
 * - Cabeceras `Cache-Control` de los GET de productos/marcas/clientes.
 *
 * No requiere base de datos ni navegador: se reemplaza `globalThis.fetch`.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAbortError } from '../lib/api-client';
import {
  CATALOG_CACHE_TTL_MS,
  CATALOG_FOCUS_REVALIDATE_AFTER_MS,
  getCatalog,
  invalidateCatalogCache,
  revalidateCatalogOnFocus,
  shouldRevalidateCatalogOnVisible,
  subscribeCatalogFocus,
} from '../lib/catalog-query-cache';
import { catalogCacheHeaders } from '../lib/catalog-http-cache';
import { createLatestRequest } from '../lib/latest-request';

type FetchCall = { url: string; init?: RequestInit };

const originalFetch = globalThis.fetch;

const stubFetch = (
  t: { after: (fn: () => void) => void },
  factory: (url: string, init?: RequestInit) => Response | Promise<Response>,
) => {
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
};

const jsonResponse = (body: unknown = { success: true }) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test('el tipeo rápido aborta la consulta anterior y no aplica resultados viejos', async () => {
  const latest = createLatestRequest();
  const applied: string[] = [];
  const slowResponse = deferred<void>();

  const oldTicket = latest.start();
  const oldQuery = (async () => {
    await slowResponse.promise;
    if (latest.isCurrent(oldTicket)) applied.push('resultado viejo');
  })();

  const newTicket = latest.start();
  assert.equal(oldTicket.signal.aborted, true, 'start() debe abortar la consulta anterior');

  const newQuery = (async () => {
    await Promise.resolve();
    if (latest.isCurrent(newTicket)) applied.push('resultado nuevo');
  })();

  await newQuery;
  slowResponse.resolve();
  await oldQuery;

  assert.deepEqual(applied, ['resultado nuevo']);
  assert.equal(latest.isCurrent(oldTicket), false);
  assert.equal(latest.isCurrent(newTicket), true);
});

test('abort() cancela la consulta en curso y la marca como obsoleta', () => {
  const latest = createLatestRequest();
  const ticket = latest.start();

  latest.abort();

  assert.equal(ticket.signal.aborted, true);
  assert.equal(latest.isCurrent(ticket), false);
});

test('deduplica promesas en vuelo y reutiliza la entrada fresca', async (t) => {
  invalidateCatalogCache();
  const response = deferred<Response>();
  const calls = stubFetch(t, () => response.promise);
  const url = '/api/products?search=dedupe&page=1';

  const first = getCatalog<{ value: number }>(url);
  const second = getCatalog<{ value: number }>(url);
  assert.equal(calls.length, 1, 'dos consumidores deben compartir un solo fetch');

  response.resolve(jsonResponse({ value: 7 }));
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, { value: 7 });
  assert.deepEqual(b, { value: 7 });

  const third = await getCatalog<{ value: number }>(url);
  assert.deepEqual(third, { value: 7 });
  assert.equal(calls.length, 1, 'la entrada fresca debe evitar otro request');
});

test('abrir/cerrar/reabrir un selector dentro del TTL no duplica requests', async (t) => {
  invalidateCatalogCache();
  const calls = stubFetch(t, () => jsonResponse({ products: [] }));
  const url = '/api/products?limit=30';
  const openController = new AbortController();

  await getCatalog(url, { signal: openController.signal });
  openController.abort(); // cerrar el selector después de resolver

  const reopenController = new AbortController();
  const reopened = await getCatalog(url, { signal: reopenController.signal });

  assert.deepEqual(reopened, { products: [] });
  assert.equal(calls.length, 1);
});

test('cancelar al único suscriptor aborta el fetch y no deja basura en caché', async (t) => {
  invalidateCatalogCache();
  const calls = stubFetch(
    t,
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
  );
  const controller = new AbortController();
  const url = '/api/products?search=abort';

  const pending = getCatalog(url, { signal: controller.signal });
  assert.equal(calls.length, 1);

  controller.abort();
  await assert.rejects(pending, (error: unknown) => isAbortError(error));
  assert.equal(calls[0].init?.signal?.aborted, true, 'el fetch subyacente debe abortarse');

  const retryController = new AbortController();
  const retry = getCatalog(url, { signal: retryController.signal });
  assert.equal(calls.length, 2, 'sin respuesta cacheada, el reintento debe consultar de nuevo');
  retryController.abort();
  await assert.rejects(retry, (error: unknown) => isAbortError(error));
});

test('si un consumidor cancela, la consulta compartida sigue para el otro', async (t) => {
  invalidateCatalogCache();
  const response = deferred<Response>();
  const calls = stubFetch(t, () => response.promise);
  const url = '/api/clients?search=compartida';
  const firstController = new AbortController();
  const secondController = new AbortController();

  const first = getCatalog(url, { signal: firstController.signal });
  const second = getCatalog(url, { signal: secondController.signal });
  assert.equal(calls.length, 1);

  firstController.abort();
  await assert.rejects(first, (error: unknown) => isAbortError(error));
  assert.equal(
    calls[0].init?.signal?.aborted,
    false,
    'el fetch compartido no debe abortarse mientras quede un suscriptor',
  );

  response.resolve(jsonResponse({ clients: [] }));
  assert.deepEqual(await second, { clients: [] });
  assert.equal(calls.length, 1);
});

test('TTL: catálogo 60 s y clientes 20 s (dentro del rango 15-30 s)', async (t) => {
  assert.equal(CATALOG_CACHE_TTL_MS.products, 60_000);
  assert.equal(CATALOG_CACHE_TTL_MS.brands, 60_000);
  assert.ok(CATALOG_CACHE_TTL_MS.clients >= 15_000);
  assert.ok(CATALOG_CACHE_TTL_MS.clients <= 30_000);

  invalidateCatalogCache();
  const calls = stubFetch(t, () => jsonResponse({ clients: [] }));
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });

  const url = '/api/clients?search=ttl';
  await getCatalog(url);
  assert.equal(calls.length, 1);

  now += CATALOG_CACHE_TTL_MS.clients - 1;
  await getCatalog(url);
  assert.equal(calls.length, 1, 'antes del TTL debe servirse de memoria');

  now += 2;
  await getCatalog(url);
  assert.equal(calls.length, 2, 'vencido el TTL debe volver a consultar');
});

test('invalidar al mutar limpia sólo el recurso afectado', async (t) => {
  invalidateCatalogCache();
  const calls = stubFetch(t, () => jsonResponse({ ok: true }));
  const productsUrl = '/api/products?search=invalidate';
  const clientsUrl = '/api/clients?search=invalidate';

  await getCatalog(productsUrl);
  await getCatalog(clientsUrl);
  assert.equal(calls.length, 2);

  await getCatalog(productsUrl);
  await getCatalog(clientsUrl);
  assert.equal(calls.length, 2, 'ambas entradas siguen frescas');

  invalidateCatalogCache('clients');
  await getCatalog(productsUrl);
  assert.equal(calls.length, 2, 'productos no debe invalidarse');
  await getCatalog(clientsUrl);
  assert.equal(calls.length, 3, 'clientes sí debe volver a consultar');

  invalidateCatalogCache('products');
  await getCatalog(productsUrl);
  assert.equal(calls.length, 4);
});

test('revalidar al volver a foco invalida y avisa a los suscriptores', async (t) => {
  invalidateCatalogCache();
  const calls = stubFetch(t, () => jsonResponse({ products: [] }));
  const url = '/api/products?search=focus';
  let notifications = 0;
  const unsubscribe = subscribeCatalogFocus(() => {
    notifications += 1;
  });

  t.after(unsubscribe);

  await getCatalog(url);
  assert.equal(calls.length, 1);

  revalidateCatalogOnFocus();
  assert.equal(notifications, 1);

  await getCatalog(url);
  assert.equal(calls.length, 2, 'después del foco debe consultarse de nuevo');
});

test('al volver a foco sólo invalida si la ausencia supera 30 s o venció el TTL', () => {
  assert.equal(CATALOG_FOCUS_REVALIDATE_AFTER_MS, 30_000);

  assert.equal(
    shouldRevalidateCatalogOnVisible({ hiddenAt: 1_000_000, now: 1_005_000 }),
    false,
    'una ausencia de 5 s no debe invalidar todo el catálogo',
  );
  assert.equal(
    shouldRevalidateCatalogOnVisible({ hiddenAt: 1_000_000, now: 1_040_000 }),
    true,
    'una ausencia de 40 s sí debe revalidar',
  );
  assert.equal(
    shouldRevalidateCatalogOnVisible({
      hiddenAt: 1_000_000,
      now: 1_005_000,
      hasExpiredEntries: true,
    }),
    true,
    'una entrada vencida por TTL natural también justifica revalidar',
  );
  assert.equal(
    shouldRevalidateCatalogOnVisible({ hiddenAt: null, now: 1_005_000 }),
    false,
    'sin una ocultación registrada no se invalida',
  );
});

test('Cache-Control: private y max-age corto para catálogo y clientes', () => {
  const products = catalogCacheHeaders('products')['Cache-Control'];
  const brands = catalogCacheHeaders('brands')['Cache-Control'];
  const clients = catalogCacheHeaders('clients')['Cache-Control'];

  assert.match(products, /^private, max-age=60, stale-while-revalidate=\d+$/);
  assert.match(brands, /^private, max-age=60, stale-while-revalidate=\d+$/);
  assert.match(clients, /^private, max-age=30, stale-while-revalidate=\d+$/);
});
