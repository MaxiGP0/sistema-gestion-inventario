/**
 * Cola offline de escrituras de pedidos.
 *
 * Guarda en IndexedDB las altas (`POST /api/orders`) y los PUT de picking que
 * no pudieron llegar al servidor (sin señal, timeout o 5xx). Cada entrada
 * conserva método, URL, body y la clave idempotente cuando corresponde:
 *
 * - Alta: clave `create:<clientRequestId>`; el mismo UUID viaja dentro del body
 *   y un reintento no crea un pedido duplicado.
 * - Picking: clave `update:<orderId>`; un nuevo guardado reemplaza al anterior
 *   para no acumular versiones viejas que fallarían por conflicto optimista.
 *
 * La cola se procesa de la más vieja a la más nueva. Este módulo sólo se
 * ejecuta en el cliente y expone la forma que consumen
 * `lib/order-put-sync-core.ts` y el service worker (`public/sw.js`).
 */

export const OFFLINE_QUEUE_DB_NAME = 'sgi-offline';
export const OFFLINE_QUEUE_DB_VERSION = 2;
export const OFFLINE_QUEUE_STORE_NAME = 'order-queue';

/** Store de la versión 1 (sólo PUT de picking); se migra al abrir la v2. */
const LEGACY_ORDER_PUT_STORE_NAME = 'order-put-queue';

/** Evento de ventana para avisar a la UI que cambió la cola. */
export const OFFLINE_QUEUE_CHANGED_EVENT = 'sgi:offline-order-queue-changed';

export type PendingOrderRequestKind = 'create' | 'update';
export type PendingOrderRequestMethod = 'POST' | 'PUT';
/**
 * `failed` significa que el servidor rechazó el contenido con un error
 * permanente (400/403/404/409...). La entrada se conserva para que el usuario
 * decida si restaurarla o descartarla, pero los eventos online no la reenvían.
 */
export type PendingOrderRequestStatus = 'pending' | 'failed';

export interface PendingOrderRequest {
  /** Clave primaria de la cola (ver `pendingOrderRequestId`). */
  id: string;
  kind: PendingOrderRequestKind;
  method: PendingOrderRequestMethod;
  url: string;
  body: unknown;
  /** Pedido afectado; presente en los PUT de picking. */
  orderId?: string;
  /** Clave idempotente del alta; presente en los POST. */
  clientRequestId?: string;
  status: PendingOrderRequestStatus;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
  /** Código HTTP del último rechazo permanente, para mostrar el motivo. */
  lastStatus?: number;
  /** Datos de presentación capturados al encolar (no se envían al servidor). */
  clientName?: string;
  total?: number;
}

/** Compatibilidad con los consumidores históricos de la cola de picking. */
export interface PendingOrderPut extends Omit<PendingOrderRequest, 'id' | 'kind' | 'method'> {
  id?: string;
  kind?: PendingOrderRequestKind;
  method?: PendingOrderRequestMethod;
}

export interface EnqueueOrderRequestInput {
  kind: PendingOrderRequestKind;
  url: string;
  body: unknown;
  orderId?: string;
  clientRequestId?: string;
  /** Nombre del cliente para el detalle de la cola (no viaja en el body). */
  clientName?: string;
  /** Importe estimado para el detalle de la cola (no viaja en el body). */
  total?: number;
}

export interface EnqueueOrderPutInput {
  orderId: string;
  url: string;
  body: unknown;
  clientName?: string;
  total?: number;
}

export interface EnqueueOrderCreateInput {
  url?: string;
  body: unknown;
  clientRequestId: string;
  clientName?: string;
  total?: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function emitQueueChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(OFFLINE_QUEUE_CHANGED_EVENT));
}

/** Clave estable de una entrada: un alta por clave y un PUT por pedido. */
export function pendingOrderRequestId(kind: PendingOrderRequestKind, reference: string): string {
  return `${kind}:${reference}`;
}

function entryReference(input: EnqueueOrderRequestInput): string {
  if (input.kind === 'create') {
    const clientRequestId = input.clientRequestId?.trim();
    if (!clientRequestId) {
      throw new Error('El alta offline necesita un clientRequestId');
    }
    return clientRequestId;
  }

  const orderId = input.orderId?.trim();
  if (!orderId) {
    throw new Error('El picking offline necesita un orderId');
  }
  return orderId;
}

function normalizeBody(body: unknown): unknown {
  return body === undefined ? null : body;
}

function buildRecord(
  input: EnqueueOrderRequestInput,
  existing: PendingOrderRequest | undefined,
): PendingOrderRequest {
  const reference = entryReference(input);
  const now = Date.now();
  const clientName = input.clientName?.trim() || existing?.clientName;
  const total =
    typeof input.total === 'number' && Number.isFinite(input.total) ? input.total : existing?.total;

  return {
    id: pendingOrderRequestId(input.kind, reference),
    kind: input.kind,
    method: input.kind === 'create' ? 'POST' : 'PUT',
    url: input.url,
    body: normalizeBody(input.body),
    ...(input.kind === 'update' ? { orderId: reference } : { clientRequestId: reference }),
    // Un payload nuevo vuelve a estar pendiente aunque reemplace a uno fallido:
    // el contenido cambió y merece un intento con las reglas actuales.
    status: 'pending',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    // Al reemplazar el payload se reinicia el conteo: los intentos anteriores
    // correspondían a otra versión del pedido.
    attempts: 0,
    ...(clientName ? { clientName } : {}),
    ...(typeof total === 'number' ? { total } : {}),
  };
}

interface LegacyPendingOrderPut {
  orderId?: unknown;
  url?: unknown;
  body?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  attempts?: unknown;
  lastAttemptAt?: unknown;
  lastError?: unknown;
}

function migrateLegacyPut(legacy: LegacyPendingOrderPut, store: IDBObjectStore): void {
  const orderId = typeof legacy.orderId === 'string' ? legacy.orderId.trim() : '';
  if (!orderId) return;

  const now = Date.now();
  const record: PendingOrderRequest = {
    id: pendingOrderRequestId('update', orderId),
    kind: 'update',
    method: 'PUT',
    url: typeof legacy.url === 'string' && legacy.url ? legacy.url : `/api/orders/${orderId}`,
    body: normalizeBody(legacy.body),
    orderId,
    status: 'pending',
    createdAt: typeof legacy.createdAt === 'number' ? legacy.createdAt : now,
    updatedAt: typeof legacy.updatedAt === 'number' ? legacy.updatedAt : now,
    attempts: typeof legacy.attempts === 'number' ? legacy.attempts : 0,
    ...(typeof legacy.lastAttemptAt === 'number' ? { lastAttemptAt: legacy.lastAttemptAt } : {}),
    ...(typeof legacy.lastError === 'string' ? { lastError: legacy.lastError } : {}),
  };

  store.put(record);
}

/**
 * Crea el store v2 y migra las entradas de la v1. La copia ocurre dentro de la
 * misma transacción `versionchange`: si algo falla, IndexedDB revierte todo y
 * la base sigue en la versión anterior.
 */
function upgradeQueueDb(db: IDBDatabase, transaction: IDBTransaction | null): void {
  const store = db.objectStoreNames.contains(OFFLINE_QUEUE_STORE_NAME)
    ? transaction?.objectStore(OFFLINE_QUEUE_STORE_NAME)
    : db.createObjectStore(OFFLINE_QUEUE_STORE_NAME, { keyPath: 'id' });

  if (!store || !db.objectStoreNames.contains(LEGACY_ORDER_PUT_STORE_NAME) || !transaction) {
    return;
  }

  const legacyStore = transaction.objectStore(LEGACY_ORDER_PUT_STORE_NAME);
  const cursorRequest = legacyStore.openCursor();

  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) {
      try {
        db.deleteObjectStore(LEGACY_ORDER_PUT_STORE_NAME);
      } catch (error) {
        console.warn('No se pudo eliminar el store legado de la cola offline:', error);
      }
      return;
    }

    migrateLegacyPut(cursor.value as LegacyPendingOrderPut, store);
    cursor.continue();
  };

  // La migración es best-effort: un registro ilegible no debe impedir abrir la
  // base ni bloquear las entradas nuevas.
  cursorRequest.onerror = (event) => {
    event.preventDefault();
    console.warn('No se pudo migrar una entrada vieja de la cola offline:', cursorRequest.error);
  };
}

function openQueueDb(): Promise<IDBDatabase> {
  if (!indexedDbAvailable()) {
    return Promise.reject(new Error('IndexedDB no está disponible en este navegador'));
  }

  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_QUEUE_DB_NAME, OFFLINE_QUEUE_DB_VERSION);

    request.onupgradeneeded = () => {
      upgradeQueueDb(request.result, request.transaction);
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
      reject(request.error ?? new Error('No se pudo abrir IndexedDB'));
    };

    request.onblocked = () => {
      // Otra pestaña con una versión anterior mantiene la base abierta. El
      // pedido queda pendiente hasta que esa pestaña se cierre.
      console.warn('IndexedDB bloqueada por otra pestaña; se reintentará.');
    };
  });

  return dbPromise;
}

/**
 * Guarda (o reemplaza) una escritura pendiente. Conserva `createdAt` para que
 * la cola mantenga el orden original.
 */
export async function enqueuePendingOrderRequest(
  input: EnqueueOrderRequestInput,
): Promise<PendingOrderRequest> {
  const db = await openQueueDb();
  const id = pendingOrderRequestId(input.kind, entryReference(input));

  const record = await new Promise<PendingOrderRequest>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(OFFLINE_QUEUE_STORE_NAME);
    const getRequest = store.get(id);
    let next: PendingOrderRequest | undefined;

    getRequest.onsuccess = () => {
      const existing = getRequest.result as PendingOrderRequest | undefined;
      next = buildRecord(input, existing);
      store.put(next);
    };

    tx.oncomplete = () => {
      if (!next) {
        reject(new Error('No se pudo guardar el pedido en IndexedDB'));
        return;
      }
      emitQueueChanged();
      resolve(next);
    };
    tx.onerror = () => reject(tx.error ?? new Error('Error de IndexedDB'));
    tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada'));
  });

  return record;
}

/** Encola un PUT de picking (un solo pendiente por pedido). */
export function enqueuePendingOrderPut(input: EnqueueOrderPutInput): Promise<PendingOrderRequest> {
  return enqueuePendingOrderRequest({
    kind: 'update',
    orderId: input.orderId,
    url: input.url,
    body: input.body,
    clientName: input.clientName,
    total: input.total,
  });
}

/** Encola un alta con la misma clave idempotente que se envió en el POST. */
export function enqueuePendingOrderCreate(
  input: EnqueueOrderCreateInput,
): Promise<PendingOrderRequest> {
  return enqueuePendingOrderRequest({
    kind: 'create',
    clientRequestId: input.clientRequestId,
    url: input.url ?? '/api/orders',
    body: input.body,
    clientName: input.clientName,
    total: input.total,
  });
}

/** Normaliza entradas guardadas por versiones anteriores o por una pestaña vieja. */
function normalizeStoredRequest(record: PendingOrderRequest): PendingOrderRequest {
  return {
    ...record,
    status: record.status === 'failed' ? 'failed' : 'pending',
    attempts: typeof record.attempts === 'number' ? record.attempts : 0,
  };
}

/** Devuelve todas las entradas pendientes, de la más vieja a la más nueva. */
export async function getPendingOrderRequests(): Promise<PendingOrderRequest[]> {
  const db = await openQueueDb();

  return new Promise<PendingOrderRequest[]>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE_NAME, 'readonly');
    const request = tx.objectStore(OFFLINE_QUEUE_STORE_NAME).getAll();

    request.onsuccess = () => {
      const records = (request.result as PendingOrderRequest[])
        .map(normalizeStoredRequest)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      resolve(records);
    };
    request.onerror = () => reject(request.error ?? new Error('No se pudo leer la cola offline'));
    tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada'));
  });
}

/** Entradas de picking; se conserva la API histórica de depósito. */
export async function getPendingOrderPuts(): Promise<PendingOrderPut[]> {
  const entries = await getPendingOrderRequests();
  return entries.filter((entry) => entry.kind === 'update');
}

/** Cantidad total de escrituras pendientes; la usa el indicador global. */
export async function countPendingOrderRequests(): Promise<number> {
  const db = await openQueueDb();

  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE_NAME, 'readonly');
    const request = tx.objectStore(OFFLINE_QUEUE_STORE_NAME).count();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('No se pudo contar la cola offline'));
    tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada'));
  });
}

/** Cantidad de pickings pendientes (compatibilidad con depósito). */
export async function countPendingOrderPuts(): Promise<number> {
  const entries = await getPendingOrderPuts();
  return entries.length;
}

/** Quita una entrada porque ya se sincronizó o porque es irrecuperable. */
export async function deletePendingOrderRequest(id: string): Promise<void> {
  const db = await openQueueDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE_NAME, 'readwrite');
    tx.objectStore(OFFLINE_QUEUE_STORE_NAME).delete(id);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Error de IndexedDB'));
    tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada'));
  });

  emitQueueChanged();
}

/** Quita el PUT pendiente de un pedido (compatibilidad con depósito). */
export function deletePendingOrderPut(orderId: string): Promise<void> {
  return deletePendingOrderRequest(pendingOrderRequestId('update', orderId));
}

/**
 * Vacía la cola completa. Se usa al cambiar de usuario: las escrituras
 * pendientes pertenecen a la sesión anterior y no deben reenviarse con otra
 * identidad. En un logout normal se intenta sincronizar antes de llamarla.
 */
export async function clearPendingOrderRequests(): Promise<void> {
  if (!indexedDbAvailable()) return;

  const db = await openQueueDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE_NAME, 'readwrite');
    tx.objectStore(OFFLINE_QUEUE_STORE_NAME).clear();

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Error de IndexedDB'));
    tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada'));
  });

  emitQueueChanged();
}

/**
 * Registra un intento transitorio fallido sin descartar la entrada. La entrada
 * sigue `pending` y se reintentará cuando el servidor o la red se recuperen.
 */
export async function markPendingOrderRequestAttempt(
  id: string,
  error: string,
  httpStatus?: number,
): Promise<void> {
  const db = await openQueueDb();
  const lastError = error.slice(0, 500);
  const now = Date.now();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(OFFLINE_QUEUE_STORE_NAME);
    const getRequest = store.get(id);

    getRequest.onsuccess = () => {
      const existing = getRequest.result as PendingOrderRequest | undefined;
      if (!existing) return;

      store.put({
        ...normalizeStoredRequest(existing),
        attempts: (existing.attempts ?? 0) + 1,
        lastAttemptAt: now,
        updatedAt: now,
        lastError,
        ...(httpStatus !== undefined ? { lastStatus: httpStatus } : {}),
      });
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Error de IndexedDB'));
    tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada'));
  });

  emitQueueChanged();
}

/**
 * Marca un rechazo permanente (400/403/404/409...). La entrada se conserva con
 * `status: 'failed'` y deja de enviarse automáticamente: el usuario decide si
 * restaurarla en un borrador, reintentarla o descartarla.
 */
export async function markPendingOrderRequestFailed(
  id: string,
  error: string,
  httpStatus?: number,
): Promise<void> {
  const db = await openQueueDb();
  const lastError = error.slice(0, 500);
  const now = Date.now();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(OFFLINE_QUEUE_STORE_NAME);
    const getRequest = store.get(id);

    getRequest.onsuccess = () => {
      const existing = getRequest.result as PendingOrderRequest | undefined;
      if (!existing) return;

      store.put({
        ...normalizeStoredRequest(existing),
        status: 'failed',
        attempts: (existing.attempts ?? 0) + 1,
        lastAttemptAt: now,
        updatedAt: now,
        lastError,
        ...(httpStatus !== undefined ? { lastStatus: httpStatus } : {}),
      } satisfies PendingOrderRequest);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Error de IndexedDB'));
    tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada'));
  });

  emitQueueChanged();
}

/**
 * Vuelve a habilitar una entrada fallida para un reintento manual. No se llama
 * desde los eventos online: sólo desde la acción explícita del usuario.
 */
export async function resetPendingOrderRequest(id: string): Promise<void> {
  const db = await openQueueDb();
  const now = Date.now();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(OFFLINE_QUEUE_STORE_NAME);
    const getRequest = store.get(id);

    getRequest.onsuccess = () => {
      const existing = getRequest.result as PendingOrderRequest | undefined;
      if (!existing) return;

      const next: PendingOrderRequest = {
        ...normalizeStoredRequest(existing),
        status: 'pending',
        attempts: 0,
        updatedAt: now,
      };
      delete next.lastError;
      delete next.lastStatus;
      store.put(next);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Error de IndexedDB'));
    tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada'));
  });

  emitQueueChanged();
}

/**
 * Borra sólo las entradas fallidas. Se usa al cerrar sesión para no filtrar
 * datos del usuario anterior, conservando las pendientes reintentables.
 */
export async function clearFailedPendingOrderRequests(): Promise<void> {
  if (!indexedDbAvailable()) return;

  const db = await openQueueDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(OFFLINE_QUEUE_STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      for (const record of request.result as PendingOrderRequest[]) {
        if (record.status === 'failed') store.delete(record.id);
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Error de IndexedDB'));
    tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada'));
  });

  emitQueueChanged();
}

/** Registra un intento fallido del PUT de un pedido (compatibilidad). */
export function markPendingOrderPutAttempt(orderId: string, error: string): Promise<void> {
  return markPendingOrderRequestAttempt(pendingOrderRequestId('update', orderId), error);
}
