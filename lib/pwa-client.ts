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

import { clearOrderDraft, type OrderDraftStorage } from '@/lib/order-draft';
import {
  clearFailedPendingOrderRequests,
  clearPendingOrderRequests,
} from '@/lib/offline-order-queue';
import { OFFLINE_CATALOG_DB_NAME, deleteOfflineCatalogDatabase } from '@/lib/offline-catalog';

/** Clave que recuerda a qué usuario pertenecen los datos offline del equipo. */
export const OFFLINE_OWNER_STORAGE_KEY = 'sgi_offline_owner';

/** Reexporta el nombre para tests y documentación (la base vive en offline-catalog). */
export { OFFLINE_CATALOG_DB_NAME };

/** Mensaje que pide al SW borrar cachés y reponer el shell estático. */
export const SERVICE_WORKER_CLEAR_MESSAGE = 'CLEAR_USER_CACHES';

function getLocalStorage(): OrderDraftStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Usuario dueño de los datos offline guardados en este navegador. */
export function readOfflineOwner(): string | null {
  const storage = getLocalStorage();
  if (!storage) return null;

  try {
    return storage.getItem(OFFLINE_OWNER_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeOfflineOwner(userId: string): void {
  const storage = getLocalStorage();
  if (!storage) return;

  try {
    storage.setItem(OFFLINE_OWNER_STORAGE_KEY, userId);
  } catch {
    // Storage bloqueado o lleno: la limpieza por cambio de usuario no aplica.
  }
}

export function clearOfflineOwner(): void {
  const storage = getLocalStorage();
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

function clearAllOrderDrafts(storage: OrderDraftStorage | null): void {
  if (!storage) return;

  try {
    for (const key of Object.keys(storage)) {
      if (key.startsWith('sgi_order_draft:')) storage.removeItem(key);
    }
  } catch {
    // Storage bloqueado: no hay borradores que borrar.
  }
}

export interface ClearUserOfflineDataOptions {
  /** Usuario que se está deslogueando (para borrar su borrador puntual). */
  userId?: string | null;
  /**
   * Vacía la cola de pedidos pendientes. Se usa al cambiar de usuario; en un
   * logout normal se conserva si quedaron escrituras sin sincronizar.
   */
  clearPendingOrders?: boolean;
}

/**
 * Limpia todos los datos offline del usuario. Es idempotente y tolerante a
 * fallos: el logout no debe quedar bloqueado por IndexedDB o Cache Storage.
 */
export async function clearUserOfflineData({
  userId,
  clearPendingOrders = false,
}: ClearUserOfflineDataOptions = {}): Promise<void> {
  const storage = getLocalStorage();

  if (userId) clearOrderDraft(storage, userId);
  clearAllOrderDrafts(storage);
  clearOfflineOwner();

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
