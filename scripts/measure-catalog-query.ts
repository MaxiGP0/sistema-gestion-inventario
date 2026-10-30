/**
 * Medición de la capa de consultas del catálogo (antes/después).
 *
 * Simula una red con latencia fija y compara:
 * 1. abrir/cerrar un selector 5 veces;
 * 2. repetir la misma búsqueda 3 veces;
 * 3. tipear rápido 6 términos (resultados que llegan fuera de orden).
 *
 * "Antes" usa `api.get` sin caché ni cancelación (comportamiento previo).
 * "Después" usa `getCatalog` + `createLatestRequest`.
 *
 * Ejecutar con: npm run measure:catalog
 */
import { api, isAbortError } from '../lib/api-client';
import { getCatalog, invalidateCatalogCache } from '../lib/catalog-query-cache';
import { createLatestRequest } from '../lib/latest-request';

const LATENCY_MS = 40;
const originalFetch = globalThis.fetch;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const installFakeNetwork = () => {
  let requests = 0;
  let completed = 0;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests += 1;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        completed += 1;
        resolve();
      }, LATENCY_MS);

      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
    return new Response(JSON.stringify({ success: true, products: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return {
    requests: () => requests,
    completed: () => completed,
    reset: () => {
      requests = 0;
      completed = 0;
    },
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

const now = () => performance.now();

async function measureOpenClose(useCache: boolean) {
  const network = installFakeNetwork();
  invalidateCatalogCache();
  const startedAt = now();

  for (let index = 0; index < 5; index += 1) {
    const url = '/api/products?limit=30&selector=repetido';
    if (useCache) await getCatalog(url);
    else await api.get(url);
  }

  const elapsedMs = now() - startedAt;
  const result = {
    requests: network.requests(),
    completed: network.completed(),
    elapsedMs: Math.round(elapsedMs),
  };
  network.restore();
  return result;
}

async function measureRepeatedSearch(useCache: boolean) {
  const network = installFakeNetwork();
  invalidateCatalogCache();
  const startedAt = now();
  const url = '/api/clients?search=cliente-repetido&limit=30';

  for (let index = 0; index < 3; index += 1) {
    if (useCache) await getCatalog(url);
    else await api.get(url);
  }

  const elapsedMs = now() - startedAt;
  const result = {
    requests: network.requests(),
    completed: network.completed(),
    elapsedMs: Math.round(elapsedMs),
  };
  network.restore();
  return result;
}

async function measureRapidTyping(useLatest: boolean) {
  const network = installFakeNetwork();
  invalidateCatalogCache();
  const latest = createLatestRequest();
  const applied: string[] = [];
  const terms = ['c', 'cl', 'cli', 'clie', 'clien', 'cliente'];
  const startedAt = now();

  await Promise.all(
    terms.map(async (term, index) => {
      await sleep(index * 25);
      const url = `/api/products?search=${term}&limit=30`;

      if (!useLatest) {
        await api.get(url);
        applied.push(term);
        return;
      }

      const ticket = latest.start();
      try {
        await getCatalog(url, { signal: ticket.signal });
        if (latest.isCurrent(ticket)) applied.push(term);
      } catch (error) {
        if (!isAbortError(error)) throw error;
      }
    }),
  );

  const elapsedMs = now() - startedAt;
  const result = {
    requests: network.requests(),
    completed: network.completed(),
    applied: applied.length,
    lastApplied: applied.at(-1) ?? null,
    elapsedMs: Math.round(elapsedMs),
  };
  network.restore();
  return result;
}

async function main() {
  interface Measurement {
    requests: number;
    completed: number;
    elapsedMs: number;
    applied?: number;
    lastApplied?: string | null;
  }

  const rows: Array<{ scenario: string; before: Measurement; after: Measurement }> = [
    {
      scenario: 'Abrir/cerrar selector x5',
      before: await measureOpenClose(false),
      after: await measureOpenClose(true),
    },
    {
      scenario: 'Misma búsqueda x3',
      before: await measureRepeatedSearch(false),
      after: await measureRepeatedSearch(true),
    },
    {
      scenario: 'Tipeo rápido (6 términos)',
      before: await measureRapidTyping(false),
      after: await measureRapidTyping(true),
    },
  ];

  console.log(`Latencia simulada: ${LATENCY_MS} ms\n`);
  for (const row of rows) {
    console.log(row.scenario);
    console.log(`  antes:   ${JSON.stringify(row.before)}`);
    console.log(`  después: ${JSON.stringify(row.after)}\n`);
  }

  const selectorBefore = rows[0].before;
  const selectorAfter = rows[0].after;
  const typingBefore = rows[2].before;
  const typingAfter = rows[2].after;
  const typingBeforeApplied = typingBefore.applied ?? 0;
  const typingAfterApplied = typingAfter.applied ?? 0;

  if (selectorAfter.requests >= selectorBefore.requests) {
    throw new Error('La caché no redujo los requests del selector');
  }
  if (typingBeforeApplied <= 1 || typingAfterApplied !== 1) {
    throw new Error('La cancelación no evitó resultados viejos en el tipeo rápido');
  }
  if (typingAfter.lastApplied !== 'cliente') {
    throw new Error('El último resultado aplicado no es el término final');
  }
}

main().catch((error) => {
  globalThis.fetch = originalFetch;
  console.error(error);
  process.exitCode = 1;
});
