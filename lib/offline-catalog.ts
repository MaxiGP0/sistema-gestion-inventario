/**
 * Catálogo offline por usuario (IndexedDB v1).
 *
 * El alta de pedidos necesita clientes y productos aunque el vendedor cierre la
 * app y vuelva a abrirla sin señal. Esta base guarda un snapshot liviano,
 * separado de la cola de escrituras (`sgi-offline`):
 *
 * - `clients`: fichas de cliente con descuentos.
 * - `brands`: marcas del catálogo.
 * - `products`: productos vistos o precargados.
 * - `recentClients`: hasta 5 clientes usados por el usuario, con frecuencia.
 * - `meta`: última sincronización por dataset (para TTL y diagnóstico).
 *
 * Cada registro incluye `userId` y `savedAt`, y su clave es `${userId}:${id}`.
 * Así dos usuarios que compartan el mismo navegador nunca leen los datos del
 * otro, ni siquiera antes de que corra la limpieza de logout.
 *
 * El formato completo, los TTL y la política de limpieza están documentados en
 * `docs/catalogo-offline.md`.
 *
 * Este módulo es seguro de importar desde el servidor: todas las operaciones
 * devuelven un resultado vacío si `indexedDB` no está disponible.
 */

import { normalizeSearchText } from './search-normalize';
import type { BrandDTO, ClientDTO, ProductDTO } from './types';

/**
 * Cliente tal como lo necesita el alta: los campos obligatorios de la ficha y
 * los opcionales que puede traer un borrador o un fixture. Es compatible tanto
 * con `ClientDTO` (API) como con `OrderCatalogClient` (formulario).
 */
export type OfflineCatalogClient = Pick<ClientDTO, '_id' | 'code' | 'name'> &
  Partial<Omit<ClientDTO, '_id' | 'code' | 'name' | 'brandDiscounts'>> & {
    brandDiscounts?: Array<{
      brandId: string | { _id: string };
      discountPercentage: number;
    }>;
  };

export const OFFLINE_CATALOG_DB_NAME = 'sgi-offline-catalog';
export const OFFLINE_CATALOG_DB_VERSION = 1;

export const OFFLINE_CATALOG_STORE_NAMES = {
  clients: 'clients',
  brands: 'brands',
  products: 'products',
  recentClients: 'recentClients',
  meta: 'meta',
} as const;

export type OfflineCatalogStoreName =
  (typeof OFFLINE_CATALOG_STORE_NAMES)[keyof typeof OFFLINE_CATALOG_STORE_NAMES];

/** Datasets con snapshot y TTL propio. `recentClients` usa el TTL de clientes. */
export type OfflineCatalogDataset = 'clients' | 'brands' | 'products';

/** Evento de ventana que avisa que cambió el snapshot (útil para la UI). */
export const OFFLINE_CATALOG_CHANGED_EVENT = 'sgi:offline-catalog-changed';

const DAY_MS = 24 * 60 * 60 * 1_000;

/** TTL por dataset. Configurable por llamada; estos son los valores por defecto. */
export const OFFLINE_CATALOG_DEFAULT_TTL_MS: Record<OfflineCatalogDataset, number> = {
  clients: 7 * DAY_MS,
  products: 7 * DAY_MS,
  brands: 30 * DAY_MS,
};

/**
 * Topes de tamaño. La escritura hace merge por `_id` y conserva los registros
 * más recientes: el snapshot no crece sin límite aunque se visiten muchas
 * búsquedas.
 */
export const OFFLINE_CATALOG_DEFAULT_LIMITS = {
  clients: 500,
  products: 500,
  brands: 500,
  recentClients: 5,
} as const;

export interface OfflineCatalogLimits {
  clients: number;
  products: number;
  brands: number;
  recentClients: number;
}

export interface OfflineCatalogTransportConfig {
  ttlMs: Record<OfflineCatalogDataset, number>;
  limits: OfflineCatalogLimits;
}

export interface OfflineCatalogConfigOverrides {
  ttlMs?: Partial<Record<OfflineCatalogDataset, number>>;
  limits?: Partial<OfflineCatalogLimits>;
}

/** Configuración efectiva del módulo. */
export const OFFLINE_CATALOG_CONFIG: OfflineCatalogTransportConfig = {
  ttlMs: { ...OFFLINE_CATALOG_DEFAULT_TTL_MS },
  limits: { ...OFFLINE_CATALOG_DEFAULT_LIMITS },
};

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(Number(value)));
}

function positiveDuration(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Number(value));
}

/** Combina los valores por defecto con overrides puntuales (tests/ajustes). */
export function buildOfflineCatalogConfig(
  overrides: OfflineCatalogConfigOverrides = {},
): OfflineCatalogTransportConfig {
  return {
    ttlMs: {
      clients: positiveDuration(overrides.ttlMs?.clients, OFFLINE_CATALOG_DEFAULT_TTL_MS.clients),
      products: positiveDuration(
        overrides.ttlMs?.products,
        OFFLINE_CATALOG_DEFAULT_TTL_MS.products,
      ),
      brands: positiveDuration(overrides.ttlMs?.brands, OFFLINE_CATALOG_DEFAULT_TTL_MS.brands),
    },
    limits: {
      clients: positiveInteger(overrides.limits?.clients, OFFLINE_CATALOG_DEFAULT_LIMITS.clients),
      products: positiveInteger(
        overrides.limits?.products,
        OFFLINE_CATALOG_DEFAULT_LIMITS.products,
      ),
      brands: positiveInteger(overrides.limits?.brands, OFFLINE_CATALOG_DEFAULT_LIMITS.brands),
      recentClients: positiveInteger(
        overrides.limits?.recentClients,
        OFFLINE_CATALOG_DEFAULT_LIMITS.recentClients,
      ),
    },
  };
}

export interface OfflineCatalogRecord<T> {
  /** `${userId}:${_id}`: evita colisiones entre usuarios en el mismo navegador. */
  key: string;
  userId: string;
  id: string;
  savedAt: number;
  data: T;
}

export interface OfflineRecentClientRecord extends OfflineCatalogRecord<OfflineCatalogClient> {
  lastUsedAt: number;
  useCount: number;
}

export interface OfflineCatalogMetaRecord {
  /** `${userId}:${dataset}`. */
  key: string;
  userId: string;
  dataset: OfflineCatalogDataset;
  savedAt: number;
  count: number;
  /**
   * Última sincronización completa del dataset. Las escrituras parciales
   * (búsquedas, primeros 50 registros del SSR) sólo actualizan `savedAt` y
   * preservan este valor; el prefetch paginado lo renueva al terminar.
   */
  fullSyncAt?: number;
}

/** Opciones de escritura del snapshot. */
export interface OfflineCatalogWriteOptions {
  /** Marca la escritura como la sincronización completa del dataset. */
  fullSync?: boolean;
}

export interface OfflineCatalogSnapshot<T> {
  items: T[];
  /** Mayor `savedAt` de los registros vigentes. */
  savedAt: number | null;
  /** `true` sólo si hay datos y ninguno venció. */
  fresh: boolean;
  /** Registros que quedaron fuera por TTL. */
  expired: number;
}

export interface OfflineCatalogWriteResult {
  savedAt: number | null;
  count: number;
}

export interface OfflineCatalogSearchOptions {
  limit?: number;
  offset?: number;
}

/** Resultado de una búsqueda local: la página pedida y el total de coincidencias. */
export interface OfflineCatalogSearchResult<T> extends OfflineCatalogSnapshot<T> {
  total: number;
}

export interface OfflineProductSearchOptions extends OfflineCatalogSearchOptions {
  brandId?: string;
}

export const EMPTY_OFFLINE_CATALOG_SNAPSHOT: Readonly<OfflineCatalogSnapshot<never>> = {
  items: [],
  savedAt: null,
  fresh: false,
  expired: 0,
};

/** Clave primaria aislada por usuario. */
export function offlineCatalogRecordKey(userId: string, id: string): string {
  return `${userId}:${id}`;
}

/** Indica si un registro está dentro de su TTL. */
export function isOfflineCatalogRecordFresh(
  savedAt: number,
  ttlMs: number,
  now = Date.now(),
): boolean {
  return Number.isFinite(savedAt) && now - savedAt <= ttlMs;
}

/** Filtra registros vencidos y devuelve también cuántos se descartaron. */
export function partitionOfflineCatalogRecords<T>(
  records: OfflineCatalogRecord<T>[],
  ttlMs: number,
  now = Date.now(),
): { fresh: OfflineCatalogRecord<T>[]; expired: number } {
  const fresh = records.filter((record) => isOfflineCatalogRecordFresh(record.savedAt, ttlMs, now));
  return { fresh, expired: records.length - fresh.length };
}

/**
 * Búsqueda local tolerante a acentos y mayúsculas. Todos los tokens deben
 * aparecer en el texto; los resultados que empiezan por el término van primero.
 */
export function rankOfflineCatalogSearch<T>(
  items: T[],
  term: string,
  fields: (item: T) => Array<unknown>,
): T[] {
  const normalizedTerm = normalizeSearchText(term);
  if (!normalizedTerm) return items;

  const tokens = normalizedTerm.split(' ').filter(Boolean);
  const ranked: Array<{ item: T; score: number; name: string }> = [];

  for (const item of items) {
    const values = fields(item)
      .map((value) => normalizeSearchText(value))
      .filter(Boolean);
    if (values.length === 0) continue;

    const haystack = values.join(' ');
    if (!tokens.every((token) => haystack.includes(token))) continue;

    const code = values[0] ?? '';
    const name = values[1] ?? '';
    const score =
      code === normalizedTerm
        ? 0
        : code.startsWith(normalizedTerm)
          ? 1
          : name.startsWith(normalizedTerm)
            ? 2
            : haystack.startsWith(normalizedTerm)
              ? 3
              : 4;

    ranked.push({ item, score, name });
  }

  ranked.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, 'es') || 0);

  return ranked.map((entry) => entry.item);
}

function brandIdOf(product: ProductDTO): string {
  const brandId = product.brandId as unknown;
  if (brandId && typeof brandId === 'object') {
    return String((brandId as { _id?: unknown })._id ?? '');
  }
  return String(brandId ?? '');
}

function slicePage<T>(items: T[], options: OfflineCatalogSearchOptions): T[] {
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = positiveInteger(options.limit, items.length || 1);
  return items.slice(offset, offset + limit);
}

function emitOfflineCatalogChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(OFFLINE_CATALOG_CHANGED_EVENT));
}

function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

let dbPromise: Promise<IDBDatabase> | null = null;

interface CatalogStoreDefinition {
  name: OfflineCatalogStoreName;
  dataset: OfflineCatalogDataset;
}

const CATALOG_STORES: CatalogStoreDefinition[] = [
  { name: OFFLINE_CATALOG_STORE_NAMES.clients, dataset: 'clients' },
  { name: OFFLINE_CATALOG_STORE_NAMES.brands, dataset: 'brands' },
  { name: OFFLINE_CATALOG_STORE_NAMES.products, dataset: 'products' },
];

function createStore(db: IDBDatabase, name: OfflineCatalogStoreName): IDBObjectStore {
  const store = db.createObjectStore(name, { keyPath: 'key' });
  store.createIndex('userId', 'userId', { unique: false });
  return store;
}

function upgradeOfflineCatalogDb(db: IDBDatabase, transaction: IDBTransaction | null): void {
  const names = new Set(db.objectStoreNames);

  for (const { name } of CATALOG_STORES) {
    if (!names.has(name)) createStore(db, name);
  }

  if (!names.has(OFFLINE_CATALOG_STORE_NAMES.recentClients)) {
    const recent = createStore(db, OFFLINE_CATALOG_STORE_NAMES.recentClients);
    recent.createIndex('lastUsedAt', 'lastUsedAt', { unique: false });
  }

  if (!names.has(OFFLINE_CATALOG_STORE_NAMES.meta)) {
    const meta = createStore(db, OFFLINE_CATALOG_STORE_NAMES.meta);
    meta.createIndex('dataset', 'dataset', { unique: false });
  }

  // `transaction` existe para que el tipado documente que la creación ocurre
  // dentro de `onupgradeneeded`; IndexedDB sólo permite crear stores ahí.
  void transaction;
}

function openOfflineCatalogDb(): Promise<IDBDatabase> {
  if (!indexedDbAvailable()) {
    return Promise.reject(new Error('IndexedDB no está disponible en este navegador'));
  }

  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_CATALOG_DB_NAME, OFFLINE_CATALOG_DB_VERSION);

    request.onupgradeneeded = () => {
      upgradeOfflineCatalogDb(request.result, request.transaction);
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('No se pudo abrir el catálogo offline'));
    };

    request.onblocked = () => {
      console.warn('El catálogo offline está bloqueado por otra pestaña.');
    };
  });

  return dbPromise;
}

/** Cierra la conexión activa para permitir borrar la base en logout. */
export async function closeOfflineCatalogDatabase(): Promise<void> {
  const current = dbPromise;
  dbPromise = null;
  if (!current) return;

  try {
    const db = await current;
    db.close();
  } catch {
    // Si la apertura falló no hay conexión que cerrar.
  }
}

/** Borra toda la base de catálogo offline (todos los usuarios del equipo). */
export async function deleteOfflineCatalogDatabase(): Promise<void> {
  await closeOfflineCatalogDatabase();
  if (!indexedDbAvailable()) return;

  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(OFFLINE_CATALOG_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    // Otra pestaña puede mantener la base abierta: no colgamos el logout.
    request.onblocked = () => resolve();
  });

  emitOfflineCatalogChanged();
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Error de IndexedDB'));
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Error de IndexedDB'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Transacción abortada'));
  });
}

async function readUserRecords<T>(
  storeName: OfflineCatalogStoreName,
  userId: string,
): Promise<Array<OfflineCatalogRecord<T>>> {
  if (!indexedDbAvailable() || !userId) return [];

  const db = await openOfflineCatalogDb();
  const transaction = db.transaction(storeName, 'readonly');
  const request = transaction.objectStore(storeName).index('userId').getAll(userId);
  const records = await requestToPromise(request);
  return records as Array<OfflineCatalogRecord<T>>;
}

function snapshotFromRecords<T>(
  records: Array<OfflineCatalogRecord<T>>,
  ttlMs: number,
  now = Date.now(),
): OfflineCatalogSnapshot<T> {
  const { fresh, expired } = partitionOfflineCatalogRecords(records, ttlMs, now);
  const items = fresh
    .slice()
    .sort((a, b) => b.savedAt - a.savedAt)
    .map((record) => record.data);
  const savedAt = fresh.reduce<number | null>(
    (max, record) => (max === null || record.savedAt > max ? record.savedAt : max),
    null,
  );

  return { items, savedAt, fresh: fresh.length > 0 && expired === 0, expired };
}

async function readSnapshot<T>(
  dataset: OfflineCatalogDataset,
  storeName: OfflineCatalogStoreName,
  userId: string,
  config: OfflineCatalogTransportConfig,
): Promise<OfflineCatalogSnapshot<T>> {
  const records = await readUserRecords<T>(storeName, userId);
  return snapshotFromRecords(records, config.ttlMs[dataset]);
}

interface WritableCatalogItem {
  _id: string;
}

async function writeSnapshot<T extends WritableCatalogItem>(
  dataset: OfflineCatalogDataset,
  storeName: OfflineCatalogStoreName,
  userId: string,
  items: T[],
  config: OfflineCatalogTransportConfig,
  options: OfflineCatalogWriteOptions = {},
): Promise<OfflineCatalogWriteResult> {
  if (!indexedDbAvailable() || !userId || items.length === 0) {
    return { savedAt: null, count: 0 };
  }

  const now = Date.now();
  const ttlMs = config.ttlMs[dataset];
  const limit = config.limits[dataset];
  const db = await openOfflineCatalogDb();
  const transaction = db.transaction([storeName, OFFLINE_CATALOG_STORE_NAMES.meta], 'readwrite');
  const store = transaction.objectStore(storeName);
  const metaStore = transaction.objectStore(OFFLINE_CATALOG_STORE_NAMES.meta);
  const metaKey = offlineCatalogRecordKey(userId, dataset);
  const [existing, previousMeta] = await Promise.all([
    requestToPromise(store.index('userId').getAll(userId)) as Promise<
      Array<OfflineCatalogRecord<T>>
    >,
    requestToPromise(metaStore.get(metaKey)) as Promise<OfflineCatalogMetaRecord | undefined>,
  ]);

  const merged = new Map<string, OfflineCatalogRecord<T>>();

  for (const record of existing) {
    if (!isOfflineCatalogRecordFresh(record.savedAt, ttlMs, now)) continue;
    merged.set(record.key, record);
  }

  for (const item of items) {
    const id = String(item._id ?? '').trim();
    if (!id) continue;

    const key = offlineCatalogRecordKey(userId, id);
    merged.set(key, { key, userId, id, savedAt: now, data: item });
  }

  const kept = [...merged.values()].sort((a, b) => b.savedAt - a.savedAt).slice(0, limit);
  const keptKeys = new Set(kept.map((record) => record.key));

  for (const record of existing) {
    if (!keptKeys.has(record.key)) store.delete(record.key);
  }
  for (const record of kept) store.put(record);

  // Una escritura parcial conserva la última sincronización completa; sólo el
  // prefetch paginado (o la primera página que ya contiene todo) la renueva.
  const fullSyncAt = options.fullSync ? now : previousMeta?.fullSyncAt;
  const meta: OfflineCatalogMetaRecord = {
    key: metaKey,
    userId,
    dataset,
    savedAt: now,
    count: kept.length,
    ...(fullSyncAt === undefined ? {} : { fullSyncAt }),
  };
  metaStore.put(meta);

  await transactionToPromise(transaction);
  emitOfflineCatalogChanged();

  return { savedAt: now, count: kept.length };
}

export function readOfflineCatalogClients(
  userId: string,
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
): Promise<OfflineCatalogSnapshot<OfflineCatalogClient>> {
  return readSnapshot('clients', OFFLINE_CATALOG_STORE_NAMES.clients, userId, config);
}

export function writeOfflineCatalogClients(
  userId: string,
  clients: OfflineCatalogClient[],
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
  options: OfflineCatalogWriteOptions = {},
): Promise<OfflineCatalogWriteResult> {
  return writeSnapshot(
    'clients',
    OFFLINE_CATALOG_STORE_NAMES.clients,
    userId,
    clients,
    config,
    options,
  );
}

export function readOfflineCatalogBrands(
  userId: string,
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
): Promise<OfflineCatalogSnapshot<BrandDTO>> {
  return readSnapshot('brands', OFFLINE_CATALOG_STORE_NAMES.brands, userId, config);
}

export function writeOfflineCatalogBrands(
  userId: string,
  brands: BrandDTO[],
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
  options: OfflineCatalogWriteOptions = {},
): Promise<OfflineCatalogWriteResult> {
  return writeSnapshot(
    'brands',
    OFFLINE_CATALOG_STORE_NAMES.brands,
    userId,
    brands,
    config,
    options,
  );
}

export function readOfflineCatalogProducts(
  userId: string,
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
): Promise<OfflineCatalogSnapshot<ProductDTO>> {
  return readSnapshot('products', OFFLINE_CATALOG_STORE_NAMES.products, userId, config);
}

export function writeOfflineCatalogProducts(
  userId: string,
  products: ProductDTO[],
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
  options: OfflineCatalogWriteOptions = {},
): Promise<OfflineCatalogWriteResult> {
  return writeSnapshot(
    'products',
    OFFLINE_CATALOG_STORE_NAMES.products,
    userId,
    products,
    config,
    options,
  );
}

/** Búsqueda local de clientes por nombre, código, dirección o localidad. */
export async function searchOfflineCatalogClients(
  userId: string,
  term: string,
  options: OfflineCatalogSearchOptions & {
    config?: OfflineCatalogTransportConfig;
  } = {},
): Promise<OfflineCatalogSearchResult<OfflineCatalogClient>> {
  const config = options.config ?? OFFLINE_CATALOG_CONFIG;
  const snapshot = await readOfflineCatalogClients(userId, config);
  const ranked = rankOfflineCatalogSearch(snapshot.items, term, (client) => [
    client.code,
    client.name,
    client.address,
    client.localidad,
    client.province,
  ]);

  return {
    ...snapshot,
    items: slicePage(ranked, options),
    total: ranked.length,
  };
}

/** Búsqueda local de productos por nombre/código, opcionalmente por marca. */
export async function searchOfflineCatalogProducts(
  userId: string,
  term: string,
  options: OfflineProductSearchOptions & {
    config?: OfflineCatalogTransportConfig;
  } = {},
): Promise<OfflineCatalogSearchResult<ProductDTO>> {
  const config = options.config ?? OFFLINE_CATALOG_CONFIG;
  const snapshot = await readOfflineCatalogProducts(userId, config);
  const filtered = options.brandId
    ? snapshot.items.filter((product) => brandIdOf(product) === options.brandId)
    : snapshot.items;
  const ranked = rankOfflineCatalogSearch(filtered, term, (product) => [
    product.code,
    product.name,
    product.brandId && typeof product.brandId === 'object' ? product.brandId.name : '',
  ]);

  return {
    ...snapshot,
    items: slicePage(ranked, options),
    total: ranked.length,
  };
}

/** Recupera productos por id (borradores restaurados, carrito). */
export async function readOfflineCatalogProductsByIds(
  userId: string,
  ids: string[],
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
): Promise<ProductDTO[]> {
  if (ids.length === 0) return [];

  const wanted = new Set(ids);
  const snapshot = await readOfflineCatalogProducts(userId, config);
  return snapshot.items.filter((product) => wanted.has(product._id));
}

/**
 * Registra el uso de un cliente. El conteo permite ordenar por frecuencia y
 * desempatar por uso más reciente; la lista se recorta a `recentClients`.
 */
export async function recordOfflineRecentClient(
  userId: string,
  client: OfflineCatalogClient,
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
): Promise<OfflineCatalogWriteResult> {
  const id = String(client?._id ?? '').trim();
  if (!indexedDbAvailable() || !userId || !id) return { savedAt: null, count: 0 };

  const now = Date.now();
  const key = offlineCatalogRecordKey(userId, id);
  const db = await openOfflineCatalogDb();
  const transaction = db.transaction(OFFLINE_CATALOG_STORE_NAMES.recentClients, 'readwrite');
  const store = transaction.objectStore(OFFLINE_CATALOG_STORE_NAMES.recentClients);
  const existing = (await requestToPromise(store.get(key))) as
    OfflineRecentClientRecord | undefined;

  const record: OfflineRecentClientRecord = {
    key,
    userId,
    id,
    savedAt: now,
    lastUsedAt: now,
    useCount: (existing?.useCount ?? 0) + 1,
    data: client,
  };
  store.put(record);

  const all = (await requestToPromise(
    store.index('userId').getAll(userId),
  )) as OfflineRecentClientRecord[];
  const sorted = all
    .filter((entry) => entry.key !== key)
    .concat(record)
    .sort((a, b) => b.useCount - a.useCount || b.lastUsedAt - a.lastUsedAt);

  const kept = sorted.slice(0, config.limits.recentClients);
  const keptKeys = new Set(kept.map((entry) => entry.key));
  for (const entry of all) {
    if (!keptKeys.has(entry.key)) store.delete(entry.key);
  }

  await transactionToPromise(transaction);
  emitOfflineCatalogChanged();

  return { savedAt: now, count: kept.length };
}

/** Clientes recientes/frecuentes del usuario, ya ordenados y acotados. */
export async function readOfflineRecentClients(
  userId: string,
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
): Promise<OfflineCatalogSnapshot<OfflineCatalogClient>> {
  const records = (await readUserRecords<OfflineCatalogClient>(
    OFFLINE_CATALOG_STORE_NAMES.recentClients,
    userId,
  )) as OfflineRecentClientRecord[];
  const now = Date.now();
  const ttlMs = config.ttlMs.clients;
  const fresh = records
    .filter((record) => isOfflineCatalogRecordFresh(record.savedAt, ttlMs, now))
    .sort((a, b) => b.useCount - a.useCount || b.lastUsedAt - a.lastUsedAt)
    .slice(0, config.limits.recentClients);

  return {
    items: fresh.map((record) => record.data),
    savedAt: fresh.reduce<number | null>(
      (max, record) => (max === null || record.savedAt > max ? record.savedAt : max),
      null,
    ),
    fresh: fresh.length > 0 && fresh.length === records.length,
    expired: records.length - fresh.length,
  };
}

/** Metadata de la última sincronización por dataset y usuario. */
export async function readOfflineCatalogMeta(
  userId: string,
  config: OfflineCatalogTransportConfig = OFFLINE_CATALOG_CONFIG,
): Promise<Partial<Record<OfflineCatalogDataset, OfflineCatalogMetaRecord>>> {
  const records = await readUserRecords<OfflineCatalogDataset>(
    OFFLINE_CATALOG_STORE_NAMES.meta,
    userId,
  );
  const now = Date.now();
  const result: Partial<Record<OfflineCatalogDataset, OfflineCatalogMetaRecord>> = {};

  for (const record of records as unknown as OfflineCatalogMetaRecord[]) {
    if (!isOfflineCatalogRecordFresh(record.savedAt, config.ttlMs[record.dataset], now)) continue;
    result[record.dataset] = record;
  }

  return result;
}

/** Borra sólo los datos de un usuario (sin tocar al resto del equipo). */
export async function clearOfflineCatalogForUser(userId: string): Promise<void> {
  if (!indexedDbAvailable() || !userId) return;

  const db = await openOfflineCatalogDb();
  const storeNames = Object.values(OFFLINE_CATALOG_STORE_NAMES);
  const transaction = db.transaction(storeNames, 'readwrite');

  for (const storeName of storeNames) {
    const store = transaction.objectStore(storeName);
    const keys = await requestToPromise(store.index('userId').getAllKeys(userId));
    for (const key of keys) store.delete(key);
  }

  await transactionToPromise(transaction);
  emitOfflineCatalogChanged();
}
