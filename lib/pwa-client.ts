'use client';

/**
 * Limpieza de datos del cliente al cerrar sesión o cambiar de usuario.
 *
 * La política completa está en docs/pwa-cache.md. En resumen:
 * - se borran todas las cachés del service worker (estáticos y catálogo);
 * - se borra la base IndexedDB del catálogo offline (cuando exista);
 * - se borran los borradores de pedido de todos los usuarios del equipo;
 * - la cola de pedidos pendientes se conserva si no se pudo sincronizar para
 *   no perder ventas; las entradas con error permanente se borran siempre y al
 *   cambiar de usuario se vacía toda la cola para no reenviarla con otra
 *   identidad.
 */

import {
  clearOrderDraft,
  ORDER_DRAFT_STORAGE_KEY,
  type OrderDraftStorage,
} from '@/lib/order-draft';
import {
  clearFailedPendingOrderRequests,
  clearPendingOrderRequests,
} from '@/lib/offline-order-queue';
import {
  OFFLINE_CATALOG_DB_NAME,
  clearOfflineClientLastOrdersForUser,
  deleteOfflineCatalogDatabase,
} from '@/lib/offline-catalog';
import { PICKING_AUTOSAVE_STORAGE_KEY } from '@/lib/picking-autosave';
import { PENDING_ORDER_COMMENT_STORAGE_KEY } from '@/lib/pending-order-comment';
import { clearAllPostControlPending as clearAllPostControlPendingStorage } from '@/lib/post-control-autosave';

/** Clave que recuerda a qué usuario pertenecen los datos offline del equipo. */
export const OFFLINE_OWNER_STORAGE_KEY = 'sgi_offline_owner';

/** Reexporta el nombre para tests y documentación (la base vive en offline-catalog). */
export { OFFLINE_CATALOG_DB_NAME };

/** Mensaje que pide al SW borrar cachés y reponer el shell estático. */
export const SERVICE_WORKER_CLEAR_MESSAGE = 'CLEAR_USER_CACHES';

/**
 * Espera una operación de IndexedDB con un tope: si otra pestaña bloquea la
 * apertura, el logout no debe quedar colgado y la eliminación completa de la
 * base sigue siendo el respaldo.
 */
function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function getLocalStorage(customStorage?: OrderDraftStorage | null): OrderDraftStorage | null {
  if (customStorage !== undefined) return customStorage;
  if (typeof window !== 'undefined') {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }
  if (typeof localStorage !== 'undefined') {
    try {
      return localStorage;
    } catch {
      return null;
    }
  }
  return null;
}

/** Usuario dueño de los datos offline guardados en este navegador. */
export function readOfflineOwner(customStorage?: OrderDraftStorage | null): string | null {
  const storage = getLocalStorage(customStorage);
  if (!storage) return null;

  try {
    return storage.getItem(OFFLINE_OWNER_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeOfflineOwner(userId: string, customStorage?: OrderDraftStorage | null): void {
  const storage = getLocalStorage(customStorage);
  if (!storage) return;

  try {
    storage.setItem(OFFLINE_OWNER_STORAGE_KEY, userId);
  } catch {
    // Storage bloqueado o lleno: la limpieza por cambio de usuario no aplica.
  }
}

export function clearOfflineOwner(customStorage?: OrderDraftStorage | null): void {
  const storage = getLocalStorage(customStorage);
  if (!storage) return;

  try {
    storage.removeItem(OFFLINE_OWNER_STORAGE_KEY);
  } catch {
    // Sin storage no hay marca que borrar.
  }
}

/**
 * Envía un mensaje al SW activo. Si todavía no controla la página, espera a
 * `ready` sin bloquear al llamador.
 */
export function postMessageToServiceWorker(message: unknown): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const controller = navigator.serviceWorker.controller;
  if (controller) {
    controller.postMessage(message);
    return;
  }

  void navigator.serviceWorker.ready
    .then((registration) => registration.active?.postMessage(message))
    .catch(() => {
      // Sin SW activo no hay cachés que limpiar desde el worker.
    });
}

/**
 * Borra todas las cachés del origen y pide al SW que vuelva a precachear el
 * shell estático. No toca IndexedDB ni localStorage.
 */
export async function clearServiceWorkerCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;

  try {
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map((key) => caches.delete(key)));
  } catch (error) {
    console.error('Error limpiando las cachés:', error);
  }

  postMessageToServiceWorker({ type: SERVICE_WORKER_CLEAR_MESSAGE });
}

/** Borra una base IndexedDB completa sin bloquearse si hay conexiones abiertas. */
export function deleteOfflineDatabase(databaseName: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();

  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(databaseName);

    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    // Otra pestaña puede mantener la base abierta: no colgamos el logout.
    request.onblocked = () => resolve();
  });
}

function listStorageKeys(storage: OrderDraftStorage): string[] {
  const keys = new Set<string>();
  const storageLike = storage as OrderDraftStorage & {
    length?: unknown;
    key?: (index: number) => string | null;
    keys?: () => Iterable<string>;
    values?: unknown;
  };

  if (typeof storageLike.length === 'number' && typeof storageLike.key === 'function') {
    for (let index = 0; index < storageLike.length; index += 1) {
      const key = storageLike.key(index);
      if (typeof key === 'string') keys.add(key);
    }
  }

  if (typeof storageLike.keys === 'function') {
    for (const key of storageLike.keys()) {
      if (typeof key === 'string') keys.add(key);
    }
  }

  if (storageLike.values instanceof Map) {
    for (const key of storageLike.values.keys()) {
      if (typeof key === 'string') keys.add(key);
    }
  }

  for (const key of Object.keys(storage)) {
    if (key !== 'values') keys.add(key);
  }

  return [...keys];
}

function clearAllOrderDrafts(storage: OrderDraftStorage | null): void {
  if (!storage) return;

  const prefixes = [
    `${ORDER_DRAFT_STORAGE_KEY}:`,
    `${PICKING_AUTOSAVE_STORAGE_KEY}:`,
    `${PENDING_ORDER_COMMENT_STORAGE_KEY}:`,
  ] as const;

  try {
    for (const key of listStorageKeys(storage)) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        storage.removeItem(key);
      }
    }
  } catch {
    // Storage bloqueado: no hay borradores ni snapshots que borrar.
  }
}

/**
 * Borra los controles post-factura pendientes (`sgi_post_control_pending:*`)
 * para que un cambio de usuario no reenvíe el trabajo del operario anterior.
 * Devuelve la cantidad de claves eliminadas.
 */
export function clearAllPostControlPending(customStorage?: OrderDraftStorage | null): number {
  const storage = getLocalStorage(customStorage);
  if (!storage) return 0;

  return clearAllPostControlPendingStorage(storage);
}

export interface ClearUserOfflineDataOptions {
  /** Usuario que se está deslogueando (para borrar su borrador puntual). */
  userId?: string | null;
  /**
   * Vacía la cola de pedidos pendientes. Se usa al cambiar de usuario; en un
   * logout normal se conserva si quedaron escrituras sin sincronizar.
   */
  clearPendingOrders?: boolean;
  /** Storage alternativo para pruebas unitarias. */
  storage?: OrderDraftStorage | null;
}

/**
 * Limpia todos los datos offline del usuario. Es idempotente y tolerante a
 * fallos: el logout no debe quedar bloqueado por IndexedDB o Cache Storage.
 */
export async function clearUserOfflineData({
  userId,
  clearPendingOrders = false,
  storage: customStorage,
}: ClearUserOfflineDataOptions = {}): Promise<void> {
  const storage = getLocalStorage(customStorage);

  if (userId) clearOrderDraft(storage, userId);
  clearAllOrderDrafts(storage);
  clearAllPostControlPending(storage);
  clearOfflineOwner(storage);

  // Los últimos pedidos contienen datos comerciales del cliente. Se borran
  // puntualmente antes de eliminar la base para que el logout no dependa de
  // que otra pestaña libere la conexión de IndexedDB.
  if (userId) {
    await settleWithin(clearOfflineClientLastOrdersForUser(userId), 1_000);
  }

  const tasks: Array<Promise<unknown>> = [
    clearServiceWorkerCaches(),
    // Cierra la conexión abierta por `offline-catalog` antes de borrar la base;
    // si otra pestaña la mantiene abierta, su `versionchange` la libera.
    deleteOfflineCatalogDatabase(),
    // Los rechazos permanentes nunca se reenvían solos. Se borran siempre al
    // cerrar sesión para no filtrar datos del usuario anterior, incluso cuando
    // las pendientes reintentables se conservan para el mismo usuario.
    clearFailedPendingOrderRequests(),
  ];

  if (clearPendingOrders) {
    tasks.push(clearPendingOrderRequests());
  }

  await Promise.allSettled(tasks);
}
