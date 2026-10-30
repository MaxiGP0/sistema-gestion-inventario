/**
 * Lógica pura de reintento de escrituras de pedidos guardadas offline.
 *
 * Procesa altas (`POST /api/orders`) y PUT de picking en el orden en que se
 * encolaron. Se separa de IndexedDB y del DOM para poder probarla con un
 * adaptador en memoria (ver `scripts/test-offline-order-queue.ts`). El wrapper
 * de cliente (`lib/order-put-sync.ts`) conecta estas reglas con la cola real.
 */

import type { PendingOrderPut, PendingOrderRequest } from './offline-order-queue';

export interface OrderQueueAdapter {
  list(): Promise<ReadonlyArray<PendingOrderRequest | PendingOrderPut>>;
  remove(requestId: string): Promise<void>;
  markAttempt(requestId: string, error: string, httpStatus?: number): Promise<void>;
  /** Conserva la entrada pero la marca como rechazada de forma permanente. */
  markFailed(requestId: string, error: string, httpStatus?: number): Promise<void>;
}

/** Alias histórico: la cola ahora también incluye altas. */
export type OrderPutQueueAdapter = OrderQueueAdapter;

export interface ProcessOrderQueueOptions {
  fetchImpl?: typeof fetch;
  isOnline?: () => boolean;
}

export type ProcessOrderPutOptions = ProcessOrderQueueOptions;

export interface OrderQueueSyncFailure {
  /** Clave de la entrada en la cola. */
  requestId: string;
  kind: PendingOrderRequest['kind'];
  orderId?: string;
  clientRequestId?: string;
  message: string;
  status?: number;
  code?: string;
  /** true = conviene reintentar; false = el body/estado ya no es aplicable. */
  retryable: boolean;
}

export type OrderPutSyncFailure = OrderQueueSyncFailure;

export interface OrderQueueSyncResult {
  synced: number;
  syncedRequestIds: string[];
  /** Ids de pedidos actualizados por PUT (compatibilidad con depósito). */
  syncedOrderIds: string[];
  failed: OrderQueueSyncFailure[];
  pending: number;
  skippedOffline: boolean;
}

export type OrderPutSyncResult = OrderQueueSyncResult;

/**
 * Estados que pueden resolverse solos más adelante (servidor caído, timeout o
 * rate limit). Un 401 también se conserva: la sesión puede renovarse al volver
 * a iniciar sesión y el pedido no debe perderse.
 */
export function isRetriableOrderPutStatus(status: number): boolean {
  return status === 401 || status === 408 || status === 429 || status >= 500;
}

/** Alias con nombre genérico para las altas. */
export const isRetriableOrderWriteStatus = isRetriableOrderPutStatus;

interface ErrorPayload {
  message: string;
  code?: string;
}

async function readErrorPayload(response: Response, fallback: string): Promise<ErrorPayload> {
  try {
    const data = (await response.clone().json()) as {
      error?: unknown;
      code?: unknown;
    };
    const message =
      typeof data?.error === 'string' && data.error.trim() ? data.error.trim() : fallback;
    const code = typeof data?.code === 'string' ? data.code : undefined;
    return { message, code };
  } catch {
    return { message: fallback };
  }
}

/**
 * Acepta también entradas de la versión 1 de la cola (sólo `orderId`), que
 * pueden llegar desde una base IndexedDB abierta por una pestaña vieja.
 */
function normalizeEntry(entry: PendingOrderRequest | PendingOrderPut): PendingOrderRequest {
  const orderId = entry.orderId;
  const kind = entry.kind ?? (orderId ? 'update' : 'create');
  const method = entry.method ?? (kind === 'create' ? 'POST' : 'PUT');
  const reference = entry.id ?? orderId ?? entry.clientRequestId ?? '';

  return {
    ...entry,
    id: reference,
    kind,
    method,
    // Las entradas de versiones anteriores no tienen status y son pendientes.
    status: entry.status === 'failed' ? 'failed' : 'pending',
  };
}

function failureOf(
  entry: PendingOrderRequest,
  message: string,
  options: {
    status?: number;
    code?: string;
    retryable: boolean;
  },
): OrderQueueSyncFailure {
  return {
    requestId: entry.id,
    kind: entry.kind,
    ...(entry.orderId ? { orderId: entry.orderId } : {}),
    ...(entry.clientRequestId ? { clientRequestId: entry.clientRequestId } : {}),
    message,
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.code ? { code: options.code } : {}),
    retryable: options.retryable,
  };
}

/**
 * Procesa la cola en orden. Las entradas `failed` se omiten: ya recibieron un
 * rechazo permanente y no deben ciclar requests 4xx en cada evento online; se
 * conservan hasta que el usuario las restaure, reintente o descarte. Los fallos
 * transitorios se conservan con el error registrado y cortan el lote para no
 * golpear un servidor caído.
 */
async function runProcessPendingOrderRequests(
  queue: OrderQueueAdapter,
  options: ProcessOrderQueueOptions,
): Promise<OrderQueueSyncResult> {
  const entries = await queue.list();
  const isOnline =
    options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);

  if (!isOnline()) {
    return {
      synced: 0,
      syncedRequestIds: [],
      syncedOrderIds: [],
      failed: [],
      pending: entries.length,
      skippedOffline: true,
    };
  }

  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);

  if (!fetchImpl) {
    throw new Error('fetch no está disponible para sincronizar pedidos');
  }

  const result: OrderQueueSyncResult = {
    synced: 0,
    syncedRequestIds: [],
    syncedOrderIds: [],
    failed: [],
    pending: entries.length,
    skippedOffline: false,
  };

  for (const rawEntry of entries) {
    const entry = normalizeEntry(rawEntry);

    // Un error permanente ya visible en la cola no se reenvía solo. El usuario
    // decide desde el centro de sincronización si restaurarlo o descartarlo.
    if (entry.status === 'failed') continue;

    let response: Response;

    try {
      response = await fetchImpl(entry.url, {
        method: entry.method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(entry.body),
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'Error de red al reintentar el pedido';

      await queue.markAttempt(entry.id, message);
      result.failed.push(
        failureOf(entry, 'Sin conexión o error de red al reintentar.', {
          retryable: true,
        }),
      );
      // Si la red falló, el resto también fallaría: se reintenta en el próximo
      // evento online / apertura de la app.
      break;
    }

    if (response.ok) {
      await queue.remove(entry.id);
      result.synced += 1;
      result.syncedRequestIds.push(entry.id);
      if (entry.orderId) result.syncedOrderIds.push(entry.orderId);
      result.pending = Math.max(0, result.pending - 1);
      continue;
    }

    const { message, code } = await readErrorPayload(response, `Error HTTP ${response.status}`);

    if (isRetriableOrderPutStatus(response.status)) {
      await queue.markAttempt(entry.id, message, response.status);
      result.failed.push(
        failureOf(entry, message, {
          status: response.status,
          ...(code ? { code } : {}),
          retryable: true,
        }),
      );
      // 401 necesita que el usuario vuelva a iniciar sesión; 5xx/429 indican
      // que el servidor no está en condiciones de recibir más writes ahora.
      break;
    }

    // Validación, permisos, pedido inexistente o conflicto de versión: el body
    // guardado ya no se puede aplicar tal cual. No se borra: queda `failed`
    // para que el usuario restaure el borrador, abra el pedido actual o
    // descarte el cambio de forma explícita.
    await queue.markFailed(entry.id, message, response.status);
    result.failed.push(
      failureOf(entry, message, {
        status: response.status,
        ...(code ? { code } : {}),
        retryable: false,
      }),
    );
  }

  return result;
}

/**
 * Un mismo adaptador no se procesa dos veces en paralelo: los eventos online,
 * foco, visibilitychange y Background Sync pueden dispararse casi juntos.
 */
const activeRuns = new WeakMap<OrderQueueAdapter, Promise<OrderQueueSyncResult>>();

export function processPendingOrderRequests(
  queue: OrderQueueAdapter,
  options: ProcessOrderQueueOptions = {},
): Promise<OrderQueueSyncResult> {
  const active = activeRuns.get(queue);
  if (active) return active;

  const run = runProcessPendingOrderRequests(queue, options).finally(() => {
    activeRuns.delete(queue);
  });

  activeRuns.set(queue, run);
  return run;
}

/** Alias histórico que siguen usando el wrapper y los tests existentes. */
export const processPendingOrderPuts = processPendingOrderRequests;
