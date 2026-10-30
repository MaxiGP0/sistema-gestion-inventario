'use client';

/**
 * Puente entre la cola IndexedDB, el reintento HTTP y el service worker.
 *
 * La cola incluye altas (`POST /api/orders`) y PUT de picking. El service
 * worker no reenvía escrituras por su cuenta: al recibir el evento Background
 * Sync avisa a las pestañas abiertas con `ORDER_SYNC_MESSAGE` y ellas ejecutan
 * `flushPendingOrders()`. Así hay un único dueño de la cola (la página), se
 * comparten las reglas de conflicto/idempotencia y el indicador se actualiza
 * sin duplicar lógica entre el SW y React.
 */

import {
  deletePendingOrderRequest,
  getPendingOrderRequests,
  markPendingOrderRequestAttempt,
  markPendingOrderRequestFailed,
} from './offline-order-queue';
import {
  processPendingOrderRequests,
  type OrderQueueAdapter,
  type OrderQueueSyncResult,
} from './order-put-sync-core';

export type { OrderQueueSyncFailure, OrderQueueSyncResult } from './order-put-sync-core';
export type { OrderPutSyncFailure, OrderPutSyncResult } from './order-put-sync-core';

/** Tag de Background Sync registrado por la página. */
export const ORDER_SYNC_TAG = 'sgi-order-put-sync';
/** Alias histórico: el tag ya cubre altas y pickings. */
export const ORDER_PUT_SYNC_TAG = ORDER_SYNC_TAG;

/** Mensaje que el service worker envía a las pestañas al despertar. */
export const ORDER_SYNC_MESSAGE = 'SGI_ORDER_PUT_SYNC';
/** Alias histórico. */
export const ORDER_PUT_SYNC_MESSAGE = ORDER_SYNC_MESSAGE;

const queueAdapter: OrderQueueAdapter = {
  list: getPendingOrderRequests,
  remove: deletePendingOrderRequest,
  markAttempt: markPendingOrderRequestAttempt,
  markFailed: markPendingOrderRequestFailed,
};

let activeFlush: Promise<OrderQueueSyncResult> | null = null;

/**
 * Reintenta todas las escrituras pendientes. Si ya hay un proceso en curso
 * devuelve esa misma promesa: online, foco, visibilitychange y el mensaje del
 * SW pueden dispararse casi juntos y no queremos envíos duplicados.
 */
export function flushPendingOrders(): Promise<OrderQueueSyncResult> {
  if (activeFlush) return activeFlush;

  activeFlush = processPendingOrderRequests(queueAdapter).finally(() => {
    activeFlush = null;
  });

  return activeFlush;
}

/** Alias histórico usado por la UI y los tests. */
export const flushPendingOrderPuts = flushPendingOrders;

interface SyncCapableRegistration extends ServiceWorkerRegistration {
  sync?: {
    register(tag: string): Promise<void>;
  };
}

/**
 * Pide al navegador que despierte el service worker cuando haya conexión.
 * `navigator.serviceWorker.ready` espera a que el SW esté activo; si el
 * navegador no soporta Background Sync simplemente se sigue usando el evento
 * online de la página. Nunca lanza: es best-effort.
 */
export async function requestOrderBackgroundSync(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }

  try {
    const registration = (await navigator.serviceWorker.ready) as SyncCapableRegistration;
    if (!registration.sync) return false;
    await registration.sync.register(ORDER_SYNC_TAG);
    return true;
  } catch (error) {
    console.warn('No se pudo registrar el Background Sync de pedidos:', error);
    return false;
  }
}

/** Alias histórico. */
export const requestOrderPutBackgroundSync = requestOrderBackgroundSync;

/** Valida el mensaje recibido desde el service worker. */
export function isOrderSyncMessage(data: unknown): boolean {
  return Boolean(
    data && typeof data === 'object' && (data as { type?: unknown }).type === ORDER_SYNC_MESSAGE,
  );
}

/** Alias histórico. */
export const isOrderPutSyncMessage = isOrderSyncMessage;
