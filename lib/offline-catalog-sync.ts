'use client';

/**
 * Puente entre la red y el snapshot de catálogo offline.
 *
 * `lib/offline-catalog.ts` sólo conoce IndexedDB. Este módulo se ocupa de
 * llenarlo con datos de la API sin bloquear la pintura del alta:
 *
 * - Primero intenta el snapshot paginado (`/api/catalog/offline-snapshot`), que
 *   incluye `updatedAt` y permite pedir deltas con `since`.
 * - Si ese endpoint todavía no está desplegado, cae al prefetch histórico de
 *   `/api/products` y `/api/clients`, acotado a los topes viejos.
 * - El full sync se acumula en memoria y recién se escribe al terminar: una
 *   interrupción no borra el snapshot anterior.
 * - Las escrituras parciales actualizan `savedAt` pero preservan `fullSyncAt` y
 *   `serverTime`; sólo el cierre de un full/delta los renueva.
 */

import { getCatalog } from './catalog-query-cache';
import {
  OFFLINE_CATALOG_CONFIG,
  OFFLINE_CATALOG_LEGACY_LIMITS,
  isOfflineCatalogRecordFresh,
  readOfflineCatalogClients,
  readOfflineCatalogMeta,
  readOfflineCatalogProducts,
  writeOfflineCatalogBrands,
  writeOfflineCatalogClients,
  writeOfflineCatalogProducts,
  type OfflineCatalogClient,
  type OfflineCatalogMetaRecord,
  type OfflineCatalogTransportConfig,
  type OfflineCatalogWriteOptions,
  type OfflineCatalogWriteResult,
} from './offline-catalog';
import type { BrandDTO, ClientListResponse, ProductDTO, ProductListResponse } from './types';

/**
 * Ventana mínima entre sincronizaciones automáticas cuando ya hay un
 * `serverTime` vigente. Los eventos de foco/visibilidad y `online` pueden
 * repetirse varias veces seguidas; el delta incremental se pide una sola vez
 * por ventana.
 */
export const MIN_AUTO_DELTA_INTERVAL_MS = 60_000;

/** Tamaño de página máximo aceptado por `GET /api/products` y `/api/clients`. */
const API_PAGE_SIZE = 200;
/** Tope por página del endpoint de snapshot. */
const SNAPSHOT_PAGE_SIZE = 500;
const SNAPSHOT_PATH = '/api/catalog/offline-snapshot';

export type OfflineCatalogSyncDataset = 'products' | 'clients';
export type OfflineCatalogSyncPhase = 'full' | 'delta' | 'done';

/** Progreso que consume la UI; `total` es 0 cuando el delta no tiene tope. */
export interface OfflineCatalogSyncProgress {
  dataset: OfflineCatalogSyncDataset;
  loaded: number;
  total: number;
  phase: OfflineCatalogSyncPhase;
}

export interface OfflineCatalogSyncOptions {
  onProgress?: (progress: OfflineCatalogSyncProgress) => void;
  signal?: AbortSignal;
  /** Fuerza la actualización manual aunque `saveData` esté activo. */
  force?: boolean;
  /** Marca explícita de sync automático (también respeta `saveData`). */
  auto?: boolean;
}

export type OfflineCatalogSyncSkipReason =
  'offline' | 'save-data' | 'aborted' | 'missing-user' | 'throttled';

export interface OfflineCatalogSyncResult {
  products: number;
  clients: number;
  fullSync: boolean;
  fallback: boolean;
  skipped: boolean;
  reason?: OfflineCatalogSyncSkipReason;
}

/** Evento de ventana con el progreso global del sync (para badges y ajustes). */
export const OFFLINE_CATALOG_SYNC_PROGRESS_EVENT = 'sgi:offline-catalog-sync-progress';

let latestProgress: OfflineCatalogSyncProgress | null = null;
const progressListeners = new Set<(progress: OfflineCatalogSyncProgress | null) => void>();

/** Último inicio de sync automático por usuario (throttle en memoria). */
const lastAutoSyncAt = new Map<string, number>();

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function publishProgress(
  progress: OfflineCatalogSyncProgress,
  onProgress?: (progress: OfflineCatalogSyncProgress) => void,
): void {
  latestProgress = progress.phase === 'done' ? null : progress;

  try {
    onProgress?.(progress);
  } catch {
    // Un consumidor roto no debe cortar la sincronización.
  }

  for (const listener of progressListeners) {
    try {
      listener(progress.phase === 'done' ? null : progress);
    } catch {
      // Idem: la UI es best-effort.
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<OfflineCatalogSyncProgress>(OFFLINE_CATALOG_SYNC_PROGRESS_EVENT, {
        detail: progress,
      }),
    );
  }
}

/** Último progreso activo, o `null` si no hay sync en curso. */
export function getOfflineCatalogSyncProgress(): OfflineCatalogSyncProgress | null {
  return latestProgress;
}

/** Suscribe la UI al progreso global. Devuelve la función de baja. */
export function subscribeOfflineCatalogSyncProgress(
  listener: (progress: OfflineCatalogSyncProgress | null) => void,
): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

/**
 * `true` cuando el sync automático puede correr: hay red y el usuario no pidió
 * ahorro de datos. La actualización manual no usa esta guarda.
 */
export function shouldAutoSyncOfflineCatalog(): boolean {
  if (typeof navigator === 'undefined' || navigator.onLine === false) return false;

  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData !== true;
}

export function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Guarda el snapshot que ya vino en el HTML del servidor. */
export async function cacheInitialOfflineCatalog(
  userId: string,
  input: { clients?: OfflineCatalogClient[]; brands?: BrandDTO[] },
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
): Promise<void> {
  if (!userId) return;

  const tasks: Array<Promise<unknown>> = [];
  if (input.clients?.length) {
    tasks.push(writeOfflineCatalogClients(userId, input.clients, config));
  }
  if (input.brands?.length) {
    tasks.push(writeOfflineCatalogBrands(userId, input.brands, config));
  }

  await Promise.allSettled(tasks);
}

interface LegacyPrefetchOptions {
  signal?: AbortSignal;
}

/**
 * Precarga legacy de productos (`GET /api/products`). Se conserva como
 * fallback del endpoint de snapshot y sigue acotada a 500 registros.
 */
export async function prefetchOfflineCatalogProducts(
  userId: string,
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
  options: LegacyPrefetchOptions = {},
): Promise<ProductDTO[]> {
  if (!userId || isBrowserOffline() || options.signal?.aborted) return [];

  const meta = await readOfflineCatalogMeta(userId, config);
  const fullSyncAt = meta.products?.fullSyncAt;
  if (fullSyncAt !== undefined && isOfflineCatalogRecordFresh(fullSyncAt, config.ttlMs.products)) {
    return [];
  }

  const max = Math.min(config.limits.products, OFFLINE_CATALOG_LEGACY_LIMITS.products);
  // El límite por página se mantiene fijo: la API pagina con `page`/`limit` y
  // achicar el último lote desplazaría el `skip` y repetiría registros.
  const pageSize = Math.min(API_PAGE_SIZE, max);
  const collected: ProductDTO[] = [];
  let page = 1;

  while (collected.length < max) {
    const params = new URLSearchParams({ page: String(page), limit: String(pageSize) });
    const data = await getCatalog<ProductListResponse>(`/api/products?${params.toString()}`, {
      force: true,
      signal: options.signal,
    });

    collected.push(...data.products);
    if (!data.hasMore || data.products.length === 0) break;
    page += 1;
  }

  const synced = collected.slice(0, max);
  if (synced.length > 0) {
    await writeOfflineCatalogProducts(userId, synced, config, { fullSync: true });
  }

  return synced;
}

/**
 * Precarga legacy de clientes (`GET /api/clients`). Mismo fallback y tope
 * histórico que productos.
 */
export async function prefetchOfflineCatalogClients(
  userId: string,
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
  options: LegacyPrefetchOptions = {},
): Promise<OfflineCatalogClient[]> {
  if (!userId || isBrowserOffline() || options.signal?.aborted) return [];

  const meta = await readOfflineCatalogMeta(userId, config);
  const fullSyncAt = meta.clients?.fullSyncAt;
  if (fullSyncAt !== undefined && isOfflineCatalogRecordFresh(fullSyncAt, config.ttlMs.clients)) {
    return [];
  }

  const max = Math.min(config.limits.clients, OFFLINE_CATALOG_LEGACY_LIMITS.clients);
  const pageSize = Math.min(API_PAGE_SIZE, max);
  const collected: OfflineCatalogClient[] = [];
  let page = 1;

  while (collected.length < max) {
    const params = new URLSearchParams({ page: String(page), limit: String(pageSize) });
    const data = await getCatalog<ClientListResponse>(`/api/clients?${params.toString()}`, {
      force: true,
      signal: options.signal,
    });

    collected.push(...data.clients);
    if (data.clients.length === 0 || page >= data.totalPages) break;
    page += 1;
  }

  const synced = collected.slice(0, max);
  if (synced.length > 0) {
    await writeOfflineCatalogClients(userId, synced, config, { fullSync: true });
  }

  return synced;
}

/**
 * Agrega los resultados de una búsqueda online al snapshot. Es best-effort:
 * un error de IndexedDB nunca debe romper la búsqueda que ya respondió la red.
 */
export function rememberOfflineCatalogClients(
  userId: string,
  clients: OfflineCatalogClient[],
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
): void {
  if (!userId || clients.length === 0) return;
  void writeOfflineCatalogClients(userId, clients, config).catch(() => {
    // Cuota llena o modo privado: la búsqueda online sigue funcionando.
  });
}

export function rememberOfflineCatalogBrands(
  userId: string,
  brands: BrandDTO[],
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
): void {
  if (!userId || brands.length === 0) return;
  void writeOfflineCatalogBrands(userId, brands, config).catch(() => {
    // Cuota llena o modo privado: el catálogo online sigue funcionando.
  });
}

export function rememberOfflineCatalogProducts(
  userId: string,
  products: ProductDTO[],
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
): void {
  if (!userId || products.length === 0) return;
  void writeOfflineCatalogProducts(userId, products, config).catch(() => {
    // Cuota llena o modo privado: el catálogo online sigue funcionando.
  });
}

type SnapshotProduct = ProductDTO & { updatedAt?: string; active?: boolean };
type SnapshotClient = OfflineCatalogClient & { updatedAt?: string };
type SnapshotItem = SnapshotProduct | SnapshotClient;

interface SnapshotResponse {
  success: true;
  type: OfflineCatalogSyncDataset;
  items: SnapshotItem[];
  nextCursor: string | null;
  hasMore: boolean;
  serverTime: string;
}

interface SnapshotPageOptions {
  cursor?: string | null;
  since?: string | null;
  limit: number;
  signal?: AbortSignal;
}

class SnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotUnavailableError';
  }
}

async function fetchSnapshotPage(
  dataset: OfflineCatalogSyncDataset,
  options: SnapshotPageOptions,
): Promise<SnapshotResponse> {
  const params = new URLSearchParams({
    type: dataset,
    limit: String(options.limit),
  });
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.since) params.set('since', options.since);

  let response: Response;
  try {
    response = await fetch(`${SNAPSHOT_PATH}?${params.toString()}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new SnapshotUnavailableError('No se pudo consultar el snapshot del catálogo');
  }

  if (!response.ok) {
    throw new SnapshotUnavailableError(`El snapshot del catálogo respondió ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SnapshotUnavailableError('El snapshot del catálogo no devolvió JSON válido');
  }

  const candidate = payload as Partial<SnapshotResponse> | null;
  if (
    !candidate ||
    candidate.success !== true ||
    candidate.type !== dataset ||
    !Array.isArray(candidate.items) ||
    typeof candidate.serverTime !== 'string'
  ) {
    throw new SnapshotUnavailableError('El snapshot del catálogo tiene un formato inesperado');
  }

  return candidate as SnapshotResponse;
}

interface SnapshotCollection {
  items: SnapshotItem[];
  serverTime: string;
}

async function fetchSnapshotPages(
  dataset: OfflineCatalogSyncDataset,
  input: {
    since?: string | null;
    max: number;
    signal?: AbortSignal;
    onProgress?: (progress: OfflineCatalogSyncProgress) => void;
  },
): Promise<SnapshotCollection> {
  const items: SnapshotItem[] = [];
  let cursor: string | null = null;
  let serverTime = new Date().toISOString();

  while (items.length < input.max) {
    const remaining = input.max - items.length;
    const page = await fetchSnapshotPage(dataset, {
      cursor,
      since: input.since,
      limit: Math.min(SNAPSHOT_PAGE_SIZE, remaining),
      signal: input.signal,
    });

    serverTime = page.serverTime || serverTime;
    const accepted = page.items.slice(0, remaining);
    items.push(...accepted);

    publishProgress(
      {
        dataset,
        loaded: items.length,
        total: input.since ? 0 : input.max,
        phase: input.since ? 'delta' : 'full',
      },
      input.onProgress,
    );

    if (
      accepted.length < page.items.length ||
      !page.hasMore ||
      !page.nextCursor ||
      page.items.length === 0
    ) {
      break;
    }
    cursor = page.nextCursor;
  }

  return { items, serverTime };
}

function writeDataset(
  userId: string,
  dataset: OfflineCatalogSyncDataset,
  items: SnapshotItem[],
  config: OfflineCatalogTransportConfig,
  options: OfflineCatalogWriteOptions,
): Promise<OfflineCatalogWriteResult> {
  if (dataset === 'products') {
    return writeOfflineCatalogProducts(userId, items as SnapshotProduct[], config, options);
  }

  return writeOfflineCatalogClients(userId, items as SnapshotClient[], config, options);
}

async function readDatasetCount(
  userId: string,
  dataset: OfflineCatalogSyncDataset,
  config: OfflineCatalogTransportConfig,
): Promise<number> {
  const snapshot =
    dataset === 'products'
      ? await readOfflineCatalogProducts(userId, config)
      : await readOfflineCatalogClients(userId, config);
  return snapshot.items.length;
}

interface DatasetSyncOutcome {
  count: number;
  fullSync: boolean;
  fallback: boolean;
}

async function fallbackDataset(
  userId: string,
  dataset: OfflineCatalogSyncDataset,
  config: OfflineCatalogTransportConfig,
  signal?: AbortSignal,
): Promise<DatasetSyncOutcome> {
  if (dataset === 'products') {
    await prefetchOfflineCatalogProducts(userId, config, { signal });
  } else {
    await prefetchOfflineCatalogClients(userId, config, { signal });
  }

  return {
    count: await readDatasetCount(userId, dataset, config),
    fullSync: true,
    fallback: true,
  };
}

async function syncDataset(
  userId: string,
  dataset: OfflineCatalogSyncDataset,
  meta: OfflineCatalogMetaRecord | undefined,
  config: OfflineCatalogTransportConfig,
  options: OfflineCatalogSyncOptions,
): Promise<DatasetSyncOutcome> {
  const { signal, onProgress } = options;
  const max = config.limits[dataset];
  const fullSyncFresh =
    meta?.fullSyncAt !== undefined &&
    isOfflineCatalogRecordFresh(meta.fullSyncAt, config.ttlMs[dataset]);
  const canDelta = Boolean(meta?.serverTime && fullSyncFresh);

  if (!canDelta) {
    let full: SnapshotCollection;
    try {
      full = await fetchSnapshotPages(dataset, {
        max,
        signal,
        onProgress,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof SnapshotUnavailableError) {
        return fallbackDataset(userId, dataset, config, signal);
      }
      throw error;
    }

    if (signal?.aborted) throw new DOMException('Sincronización cancelada', 'AbortError');

    const written = await writeDataset(userId, dataset, full.items, config, {
      fullSync: true,
      replace: true,
      serverTime: full.serverTime,
    });
    let count = written.count;

    // Cierra la ventana entre la última página del full y la escritura local.
    try {
      const delta = await fetchSnapshotPages(dataset, {
        since: full.serverTime,
        max,
        signal,
        onProgress,
      });
      const deltaWritten = await writeDataset(userId, dataset, delta.items, config, {
        serverTime: delta.serverTime,
      });
      count = deltaWritten.count;
    } catch (error) {
      if (isAbortError(error)) throw error;
      // El full ya quedó guardado. Si el delta falla, el próximo intento
      // arranca desde `full.serverTime`.
    }

    publishProgress({ dataset, loaded: count, total: count, phase: 'done' }, onProgress);
    return { count, fullSync: true, fallback: false };
  }

  let delta: SnapshotCollection;
  try {
    delta = await fetchSnapshotPages(dataset, {
      since: meta?.serverTime,
      max,
      signal,
      onProgress,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof SnapshotUnavailableError) {
      return fallbackDataset(userId, dataset, config, signal);
    }
    throw error;
  }

  if (signal?.aborted) throw new DOMException('Sincronización cancelada', 'AbortError');

  const written = await writeDataset(userId, dataset, delta.items, config, {
    serverTime: delta.serverTime,
  });
  publishProgress(
    { dataset, loaded: written.count, total: written.count, phase: 'done' },
    onProgress,
  );
  return { count: written.count, fullSync: false, fallback: false };
}

/**
 * Sincroniza productos y clientes con el snapshot incremental.
 *
 * 1. Si no hay un full sync vigente (o el endpoint venía del fallback legacy),
 *    descarga todas las páginas y recién entonces reemplaza el snapshot.
 * 2. Con `serverTime` guardado, pide sólo `updatedAt > serverTime`.
 * 3. Un delta posterior al full cierra los cambios ocurridos durante la
 *    descarga.
 */
export async function syncOfflineCatalog(
  userId: string,
  options: OfflineCatalogSyncOptions = {},
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
): Promise<OfflineCatalogSyncResult> {
  const base: OfflineCatalogSyncResult = {
    products: 0,
    clients: 0,
    fullSync: false,
    fallback: false,
    skipped: false,
  };

  if (!userId) return { ...base, skipped: true, reason: 'missing-user' };
  if (isBrowserOffline()) return { ...base, skipped: true, reason: 'offline' };
  // El modo automático (y cualquier llamada sin `force`) respeta el ahorro de
  // datos. La tarjeta de ajustes usa `force: true` para la actualización manual.
  if (!options.force && !shouldAutoSyncOfflineCatalog()) {
    return { ...base, skipped: true, reason: 'save-data' };
  }
  if (options.signal?.aborted) {
    return { ...base, skipped: true, reason: 'aborted' };
  }

  try {
    const meta = await readOfflineCatalogMeta(userId, config);
    const now = Date.now();

    // Con ambos datasets ya sincronizados, el modo automático sólo necesita
    // pedir deltas. El throttle evita que foco + online + montaje disparen la
    // misma consulta varias veces en pocos segundos.
    const deltaReady = Boolean(meta.products?.serverTime && meta.clients?.serverTime);
    if (options.auto && deltaReady) {
      const lastSyncAt = lastAutoSyncAt.get(userId);
      if (lastSyncAt !== undefined && now - lastSyncAt < MIN_AUTO_DELTA_INTERVAL_MS) {
        return { ...base, skipped: true, reason: 'throttled' };
      }
    }
    if (options.auto) lastAutoSyncAt.set(userId, now);

    const products = await syncDataset(userId, 'products', meta.products, config, options);

    if (options.signal?.aborted) {
      return {
        ...base,
        products: products.count,
        fullSync: products.fullSync,
        fallback: products.fallback,
        skipped: true,
        reason: 'aborted',
      };
    }

    const clients = await syncDataset(userId, 'clients', meta.clients, config, options);

    return {
      products: products.count,
      clients: clients.count,
      fullSync: products.fullSync || clients.fullSync,
      fallback: products.fallback || clients.fallback,
      skipped: false,
    };
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      return { ...base, skipped: true, reason: 'aborted' };
    }
    throw error;
  }
}
