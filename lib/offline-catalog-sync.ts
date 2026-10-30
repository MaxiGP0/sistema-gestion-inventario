'use client';

/**
 * Puente entre la red y el snapshot de catálogo offline.
 *
 * `lib/offline-catalog.ts` sólo conoce IndexedDB. Este módulo se ocupa de
 * llenarlo con datos de la API sin bloquear la pintura del alta:
 *
 * - Los datos que ya llegaron del servidor (primeros 50 clientes y marcas) se
 *   escriben al montar.
 * - Después se precargan hasta 500 productos y 500 clientes en segundo plano,
 *   una vez por TTL. Sin este paso el buscador offline no tendría con qué
 *   responder en frío.
 * - Cada búsqueda online agrega sus resultados al snapshot (merge por `_id`),
 *   así el vendedor también puede encontrar offline lo que ya consultó.
 *
 * Las escrituras parciales actualizan `savedAt` pero preservan `fullSyncAt`:
 * sólo el prefetch paginado marca el dataset como completo.
 */

import { getCatalog } from './catalog-query-cache';
import {
  OFFLINE_CATALOG_CONFIG,
  isOfflineCatalogRecordFresh,
  readOfflineCatalogMeta,
  writeOfflineCatalogBrands,
  writeOfflineCatalogClients,
  writeOfflineCatalogProducts,
  type OfflineCatalogClient,
  type OfflineCatalogTransportConfig,
} from './offline-catalog';
import type { BrandDTO, ClientListResponse, ProductDTO, ProductListResponse } from './types';

/** Tamaño de página máximo aceptado por `GET /api/products` y `/api/clients`. */
const API_PAGE_SIZE = 200;

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

/**
 * Precarga productos para el buscador offline. Sólo corre si no hay una
 * sincronización completa vigente; haber guardado la primera página del SSR no
 * alcanza para abortarlo. Respeta el tope configurado (500 por defecto).
 */
export async function prefetchOfflineCatalogProducts(
  userId: string,
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
): Promise<ProductDTO[]> {
  if (!userId || isBrowserOffline()) return [];

  const meta = await readOfflineCatalogMeta(userId, config);
  const fullSyncAt = meta.products?.fullSyncAt;
  if (fullSyncAt !== undefined && isOfflineCatalogRecordFresh(fullSyncAt, config.ttlMs.products)) {
    return [];
  }

  const max = config.limits.products;
  // El límite por página se mantiene fijo: la API pagina con `page`/`limit` y
  // achicar el último lote desplazaría el `skip` y repetiría registros.
  const pageSize = Math.min(API_PAGE_SIZE, max);
  const collected: ProductDTO[] = [];
  let page = 1;

  while (collected.length < max) {
    const params = new URLSearchParams({ page: String(page), limit: String(pageSize) });
    const data = await getCatalog<ProductListResponse>(`/api/products?${params.toString()}`, {
      force: true,
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
 * Precarga clientes para el buscador offline. Completa en segundo plano lo que
 * el SSR sólo trajo como primera página, en lotes de hasta 200 registros y con
 * el mismo tope que el resto del snapshot (500 por defecto).
 */
export async function prefetchOfflineCatalogClients(
  userId: string,
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
): Promise<OfflineCatalogClient[]> {
  if (!userId || isBrowserOffline()) return [];

  const meta = await readOfflineCatalogMeta(userId, config);
  const fullSyncAt = meta.clients?.fullSyncAt;
  if (fullSyncAt !== undefined && isOfflineCatalogRecordFresh(fullSyncAt, config.ttlMs.clients)) {
    return [];
  }

  const max = config.limits.clients;
  const pageSize = Math.min(API_PAGE_SIZE, max);
  const collected: OfflineCatalogClient[] = [];
  let page = 1;

  while (collected.length < max) {
    const params = new URLSearchParams({ page: String(page), limit: String(pageSize) });
    const data = await getCatalog<ClientListResponse>(`/api/clients?${params.toString()}`, {
      force: true,
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
