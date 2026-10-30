/**
 * Caché en memoria (sólo navegador) para los GET de catálogo que alimentan
 * selectores y buscadores: `/api/products`, `/api/brands` y `/api/clients`.
 *
 * - TTL corto: clientes 20 s (sus descuentos afectan el precio del pedido) y
 *   catálogo 60 s (productos/marcas cambian poco).
 * - Deduplicación: dos consumidores que piden la misma URL comparten una sola
 *   promesa en vuelo. Si todos cancelan, se aborta el `fetch` subyacente.
 * - Invalidación: `invalidateCatalogCache(...)` limpia entradas y aborta
 *   consultas en curso. Se llama después de mutar productos/marcas/clientes.
 * - Foco: `subscribeCatalogFocus()` registra un único listener de
 *   `focus`/`visibilitychange`; al volver a la pestaña invalida todo y avisa a
 *   los suscriptores para que vuelvan a consultar.
 *
 * Sólo debe importarse desde componentes/hooks de cliente. No reemplaza la
 * caché del servidor (`lib/catalog-cache.ts`): son capas independientes.
 */

import { api, type ApiRequestOptions } from './api-client';

export type CatalogResource = 'products' | 'brands' | 'clients';

/** TTL por recurso; clientes es más corto porque sus descuentos cambian precios. */
export const CATALOG_CACHE_TTL_MS: Record<CatalogResource, number> = {
  products: 60_000,
  brands: 60_000,
  clients: 20_000,
};

const RESOURCE_PATHS: Record<CatalogResource, string> = {
  products: '/api/products',
  brands: '/api/brands',
  clients: '/api/clients',
};

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

interface InFlightEntry {
  controller: AbortController;
  subscribers: number;
  promise: Promise<unknown>;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, InFlightEntry>();
const focusListeners = new Set<() => void>();

let focusInstalled = false;
let lastFocusRevalidation = 0;
const FOCUS_COOLDOWN_MS = 1_000;

/** Devuelve el recurso cacheable de una URL, o `null` si no corresponde. */
export function catalogResourceForUrl(url: string): CatalogResource | null {
  let pathname: string;
  try {
    pathname = new URL(url, 'http://localhost').pathname;
  } catch {
    return null;
  }

  for (const [resource, path] of Object.entries(RESOURCE_PATHS) as [CatalogResource, string][]) {
    if (pathname === path) return resource;
  }
  return null;
}

function ttlForUrl(url: string): number {
  const resource = catalogResourceForUrl(url);
  return resource ? CATALOG_CACHE_TTL_MS[resource] : 0;
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  if (typeof DOMException !== 'undefined') {
    return new DOMException('La consulta fue cancelada', 'AbortError');
  }
  const error = new Error('La consulta fue cancelada');
  error.name = 'AbortError';
  return error;
}

/** Espera la promesa compartida, pero rechaza en cuanto el llamador cancela. */
function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function release(url: string, entry: InFlightEntry): void {
  entry.subscribers -= 1;
  if (entry.subscribers > 0) return;

  // Nadie sigue esperando: se cancela el fetch compartido y se olvida para que
  // un nuevo consumidor arranque limpio.
  if (inFlight.get(url) === entry) inFlight.delete(url);
  if (!entry.controller.signal.aborted) entry.controller.abort();
}

export interface CatalogRequestOptions extends ApiRequestOptions {
  /** Ignora una entrada fresca y fuerza una consulta nueva. */
  force?: boolean;
}

/**
 * GET cacheado con deduplicación. Para URLs ajenas al catálogo delega en
 * `api.get` sin cachear.
 *
 * Si `signal` se aborta, la promesa de ese llamador rechaza con `AbortError`;
 * la consulta compartida sólo se cancela cuando no queda ningún suscriptor.
 */
export async function getCatalog<T>(url: string, options: CatalogRequestOptions = {}): Promise<T> {
  const resource = catalogResourceForUrl(url);
  if (!resource) {
    const requestOptions = { ...options };
    delete requestOptions.force;
    return api.get<T>(url, requestOptions);
  }

  const { force = false, signal, ...requestOptions } = options;
  const now = Date.now();

  if (!force) {
    const cached = cache.get(url);
    if (cached && cached.expiresAt > now) {
      if (signal?.aborted) throw abortReason(signal);
      return cached.value as T;
    }
    if (cached) cache.delete(url);
  }

  const existing = inFlight.get(url);
  if (existing) {
    existing.subscribers += 1;
    try {
      return (await waitForAbort(existing.promise, signal)) as T;
    } finally {
      release(url, existing);
    }
  }

  const controller = new AbortController();
  const entry: InFlightEntry = {
    controller,
    subscribers: 1,
    promise: Promise.resolve(),
  };
  inFlight.set(url, entry);

  entry.promise = api
    .get<T>(url, {
      // La caché de esta capa manda: al invalidar (mutación/foco) el próximo
      // request debe revalidar contra el servidor y no reutilizar la copia
      // HTTP que el navegador guardó con `Cache-Control: max-age`.
      cache: 'no-cache',
      ...requestOptions,
      signal: controller.signal,
    })
    .then((value) => {
      cache.set(url, { value, expiresAt: Date.now() + ttlForUrl(url) });
      return value;
    })
    .finally(() => {
      if (inFlight.get(url) === entry) inFlight.delete(url);
    });

  try {
    return (await waitForAbort(entry.promise, signal)) as T;
  } finally {
    release(url, entry);
  }
}

function matchesResource(url: string, resources: Set<CatalogResource>): boolean {
  const resource = catalogResourceForUrl(url);
  return resource !== null && resources.has(resource);
}

/**
 * Invalida entradas y aborta consultas en curso. Sin argumentos limpia todo el
 * catálogo; con recursos, sólo las URLs de esos recursos.
 */
export function invalidateCatalogCache(...resources: CatalogResource[]): void {
  const targets = new Set<CatalogResource>(
    resources.length > 0 ? resources : (Object.keys(RESOURCE_PATHS) as CatalogResource[]),
  );

  for (const url of cache.keys()) {
    if (matchesResource(url, targets)) cache.delete(url);
  }

  for (const [url, entry] of inFlight) {
    if (!matchesResource(url, targets)) continue;
    inFlight.delete(url);
    if (!entry.controller.signal.aborted) entry.controller.abort();
  }
}

function notifyFocusRevalidation(): void {
  invalidateCatalogCache();
  for (const listener of focusListeners) {
    try {
      listener();
    } catch {
      // Un suscriptor roto no debe impedir que el resto revalide.
    }
  }
}

/**
 * Revalida manualmente todo el catálogo (también se usa en tests). Invalida la
 * caché, aborta consultas en curso y avisa a los suscriptores de foco.
 */
export function revalidateCatalogOnFocus(): void {
  notifyFocusRevalidation();
}

function installFocusListener(): void {
  if (focusInstalled || typeof window === 'undefined') return;
  focusInstalled = true;

  const onFocus = () => {
    const now = Date.now();
    if (now - lastFocusRevalidation < FOCUS_COOLDOWN_MS) return;
    lastFocusRevalidation = now;
    notifyFocusRevalidation();
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') onFocus();
  };

  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibilityChange);
}

/**
 * Suscribe una revalidación al volver a foco/visibilidad. Devuelve la función
 * para desuscribirse (se llama al desmontar el hook).
 */
export function subscribeCatalogFocus(listener: () => void): () => void {
  focusListeners.add(listener);
  installFocusListener();
  return () => {
    focusListeners.delete(listener);
  };
}
