/**
 * Pruebas de la cola offline de escrituras de pedidos (altas y pickings):
 * - Un POST/PUT exitoso descarta la entrada.
 * - El alta conserva `clientRequestId` en el body y usa POST.
 * - Un error de red o 5xx conserva la entrada y registra el intento.
 * - Un 4xx no reintentable queda como `failed`, conserva el body y no se
 *   reenvía automáticamente en los siguientes flushes.
 * - Un alta fallida se puede volcar de nuevo al borrador de /orders/new.
 * - Sin conexión no se llama a fetch.
 * - Un doble flush concurrente no envía dos veces la misma entrada.
 * - La cola se procesa en orden y se detiene ante un fallo transitorio.
 * - El service worker escucha Background Sync y avisa a las pestañas.
 *
 * No requiere base de datos: se usa un adaptador en memoria, `fake-indexeddb`
 * para la persistencia real y fetch mockeado con `Response` de Node.
 *
 * Ejecutar con: npm test
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import type { PendingOrderRequest } from '../lib/offline-order-queue';
import {
  clearFailedPendingOrderRequests,
  clearPendingOrderRequests,
  deletePendingOrderRequest,
  enqueuePendingOrderCreate,
  enqueuePendingOrderPut,
  getPendingOrderRequests,
  markPendingOrderRequestAttempt,
  markPendingOrderRequestFailed,
  resetPendingOrderRequest,
} from '../lib/offline-order-queue';
import {
  buildOrderDraftFromQueueEntry,
  isDraftEditQueueEntry,
  restoreOrderDraftFromQueueEntry,
} from '../lib/offline-order-restore';
import {
  createOrderDraft,
  getOrderDraftStorageKey,
  loadOrderDraft,
  saveOrderDraft,
} from '../lib/order-draft';
import {
  getPendingOrderCommentStorageKey,
  savePendingOrderComment,
} from '../lib/pending-order-comment';
import {
  buildPickingAutosaveFromOrderPut,
  getPickingAutosaveStorageKey,
  parsePickingAutosave,
  savePickingAutosave,
} from '../lib/picking-autosave';
import { clearUserOfflineData } from '../lib/pwa-client';
import {
  isRetriableOrderPutStatus,
  processPendingOrderPuts,
  type OrderQueueAdapter,
} from '../lib/order-put-sync-core';

const orderId = '507f1f77bcf86cd799439011';
const clientId = '507f1f77bcf86cd799439099';

const makeUpdateEntry = (id: string = orderId, createdAt: number = 1): PendingOrderRequest => ({
  id: `update:${id}`,
  kind: 'update',
  method: 'PUT',
  orderId: id,
  url: `/api/orders/${id}`,
  body: { status: 'facturacion', version: 3, items: [] },
  status: 'pending',
  createdAt,
  updatedAt: createdAt,
  attempts: 0,
});

const makeCreateEntry = (
  clientRequestId = 'uuid-request-1',
  createdAt: number = 1,
): PendingOrderRequest => ({
  id: `create:${clientRequestId}`,
  kind: 'create',
  method: 'POST',
  clientRequestId,
  url: '/api/orders',
  body: {
    clientId,
    items: [
      {
        productId: '507f1f77bcf86cd799439022',
        requestedQuantity: 2,
        customDiscount: 5,
      },
    ],
    invoiceType: 'A',
    paymentCondition: 'contado',
    clientRequestId,
  },
  status: 'pending',
  createdAt,
  updatedAt: createdAt,
  attempts: 0,
});

const makeAdapter = (initial: PendingOrderRequest[]) => {
  const queue = new Map(initial.map((entry) => [entry.id, entry]));
  const attempts: Array<{ requestId: string; error: string }> = [];
  const failures: Array<{ requestId: string; error: string; status?: number }> = [];

  const adapter: OrderQueueAdapter = {
    async list() {
      return [...queue.values()].sort(
        (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      );
    },
    async remove(id) {
      queue.delete(id);
    },
    async markAttempt(id, error, httpStatus) {
      attempts.push({ requestId: id, error });
      const current = queue.get(id);
      if (!current) return;
      queue.set(id, {
        ...current,
        attempts: current.attempts + 1,
        lastError: error,
        ...(httpStatus !== undefined ? { lastStatus: httpStatus } : {}),
      });
    },
    async markFailed(id, error, httpStatus) {
      failures.push({ requestId: id, error, status: httpStatus });
      const current = queue.get(id);
      if (!current) return;
      queue.set(id, {
        ...current,
        status: 'failed',
        attempts: current.attempts + 1,
        lastAttemptAt: Date.now(),
        lastError: error,
        ...(httpStatus !== undefined ? { lastStatus: httpStatus } : {}),
      });
    },
  };

  return { queue, attempts, failures, adapter };
};

const jsonResponse = (status: number, body: object = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const mockFetch = (factory: () => Response | Promise<Response>) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return factory();
  }) as typeof fetch;

  return { calls, fetchImpl };
};

test('los estados transitorios se reintentan y los permanentes no', () => {
  assert.equal(isRetriableOrderPutStatus(401), true);
  assert.equal(isRetriableOrderPutStatus(408), true);
  assert.equal(isRetriableOrderPutStatus(429), true);
  assert.equal(isRetriableOrderPutStatus(500), true);
  assert.equal(isRetriableOrderPutStatus(503), true);

  assert.equal(isRetriableOrderPutStatus(400), false);
  assert.equal(isRetriableOrderPutStatus(403), false);
  assert.equal(isRetriableOrderPutStatus(404), false);
  assert.equal(isRetriableOrderPutStatus(409), false);
  assert.equal(isRetriableOrderPutStatus(422), false);
});

test('un alta exitosa envía POST con clientRequestId y descarta la entrada', async () => {
  const entry = makeCreateEntry();
  const { queue, adapter } = makeAdapter([entry]);
  const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, { success: true }));

  const result = await processPendingOrderPuts(adapter, {
    fetchImpl,
    isOnline: () => true,
  });

  assert.equal(result.synced, 1);
  assert.deepEqual(result.syncedRequestIds, [entry.id]);
  assert.deepEqual(result.syncedOrderIds, []);
  assert.equal(result.pending, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(queue.size, 0, 'la entrada debe quedar eliminada');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/orders');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), entry.body);
  assert.equal(
    JSON.parse(String(calls[0].init?.body)).clientRequestId,
    'uuid-request-1',
    'la clave idempotente debe viajar en el body',
  );
});

test('un PUT de picking exitoso conserva el método y descarta la entrada', async () => {
  const entry = makeUpdateEntry();
  const { queue, adapter } = makeAdapter([entry]);
  const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, { success: true }));

  const result = await processPendingOrderPuts(adapter, {
    fetchImpl,
    isOnline: () => true,
  });

  assert.equal(result.synced, 1);
  assert.deepEqual(result.syncedRequestIds, [entry.id]);
  assert.deepEqual(result.syncedOrderIds, [orderId]);
  assert.equal(queue.size, 0);

  assert.equal(calls[0].url, `/api/orders/${orderId}`);
  assert.equal(calls[0].init?.method, 'PUT');
});

test('un error de red conserva la entrada, registra el intento y corta el lote', async () => {
  const entry = makeCreateEntry();
  const { queue, attempts, adapter } = makeAdapter([entry]);
  const { fetchImpl } = mockFetch(() => {
    throw new TypeError('Failed to fetch');
  });

  const result = await processPendingOrderPuts(adapter, {
    fetchImpl,
    isOnline: () => true,
  });

  assert.equal(result.synced, 0);
  assert.equal(result.pending, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].kind, 'create');
  assert.equal(result.failed[0].clientRequestId, 'uuid-request-1');
  assert.equal(result.failed[0].retryable, true);
  assert.match(result.failed[0].message, /sin conexión|error de red/i);
  assert.equal(queue.size, 1, 'el pedido no debe perderse');
  assert.equal(queue.get(entry.id)?.attempts, 1);
  assert.match(queue.get(entry.id)?.lastError ?? '', /Failed to fetch/);
  assert.equal(attempts.length, 1);
});

test('un 409 por conflicto de versión conserva el PUT como fallido y no se reintenta', async () => {
  const entry = makeUpdateEntry();
  const { queue, failures, adapter } = makeAdapter([entry]);
  const { fetchImpl } = mockFetch(() =>
    jsonResponse(409, {
      error:
        'Conflicto de versión: el pedido fue modificado por otro usuario. Recargá el pedido y volvé a intentarlo.',
      code: 'ORDER_VERSION_CONFLICT',
    }),
  );

  const result = await processPendingOrderPuts(adapter, {
    fetchImpl,
    isOnline: () => true,
  });

  assert.equal(result.synced, 0);
  assert.equal(result.pending, 1, 'la entrada debe seguir en la cola');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].retryable, false);
  assert.equal(result.failed[0].status, 409);
  assert.equal(result.failed[0].code, 'ORDER_VERSION_CONFLICT');
  assert.match(result.failed[0].message, /conflicto de versión/i);
  assert.equal(queue.size, 1);
  assert.equal(queue.get(entry.id)?.status, 'failed');
  assert.equal(queue.get(entry.id)?.lastStatus, 409);
  assert.match(queue.get(entry.id)?.lastError ?? '', /conflicto de versión/i);
  assert.equal(typeof queue.get(entry.id)?.lastAttemptAt, 'number');
  assert.deepEqual(failures, [
    { requestId: entry.id, error: result.failed[0].message, status: 409 },
  ]);
});

test('un PUT rechazado se reconstruye como autosave sobre la versión vigente', () => {
  const localOrderId = '507f1f77bcf86cd799439055';
  const snapshot = buildPickingAutosaveFromOrderPut({
    orderId: localOrderId,
    userId: 'user-deposito',
    version: 7,
    savedAt: 1234,
    items: [
      {
        _id: 'linea-1',
        productId: 'producto-1',
        requestedQuantity: 5,
        verifiedQuantity: 3,
        isPending: false,
        pendingReason: 'Faltante parcial',
      },
      {
        productId: 'producto-2',
        requestedQuantity: 2,
        verifiedQuantity: 0,
        isPending: true,
        pendingReason: 'Sin stock en depósito',
      },
      {
        productId: { _id: 'producto-3' },
        requestedQuantity: 1,
        verifiedQuantity: 1,
        isPending: false,
      },
      { productId: 'sin-cantidad' },
      null,
    ],
  });

  assert.ok(snapshot);
  assert.equal(snapshot.orderId, localOrderId);
  assert.equal(snapshot.userId, 'user-deposito');
  assert.equal(snapshot.version, 7);
  assert.equal(snapshot.savedAt, 1234);
  assert.deepEqual(snapshot.items, {
    'linea-1': {
      verifiedQty: 3,
      controlled: true,
      pendingReason: 'Faltante parcial',
    },
    'producto-2': {
      verifiedQty: 0,
      controlled: false,
      pendingReason: 'Sin stock en depósito',
    },
    'producto-3': {
      verifiedQty: 1,
      controlled: true,
      pendingReason: '',
    },
  });

  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };

  assert.equal(savePickingAutosave(storage, snapshot), true);
  const stored = parsePickingAutosave(
    storage.getItem(getPickingAutosaveStorageKey('user-deposito', localOrderId)),
  );
  assert.deepEqual(stored, snapshot);

  // Sin líneas válidas no se debe generar un snapshot vacío que pise el actual.
  assert.equal(
    buildPickingAutosaveFromOrderPut({
      orderId: localOrderId,
      userId: 'user-deposito',
      version: 8,
      items: [{ productId: 'sin-cantidad' }],
    }),
    null,
  );
});

test('un fetch que nunca responde vence por timeout, marca el intento y corta el lote', async () => {
  const entry = makeCreateEntry();
  const { queue, attempts, adapter } = makeAdapter([entry]);
  let receivedSignal: AbortSignal | undefined;

  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    receivedSignal = init?.signal ?? undefined;
    // Simula una red colgada que ignora el abort: la promesa nunca resuelve.
    return new Promise<Response>(() => {});
  }) as typeof fetch;

  const startedAt = Date.now();
  const result = await processPendingOrderPuts(adapter, {
    fetchImpl,
    isOnline: () => true,
    timeoutMs: 25,
  });

  assert.ok(Date.now() - startedAt < 1_000, 'el sync no debe quedar pendiente');
  assert.equal(result.synced, 0);
  assert.equal(result.pending, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].retryable, true);
  assert.equal(result.failed[0].status, 0);
  assert.match(result.failed[0].message, /tardó demasiado/i);
  assert.equal(queue.size, 1, 'el pedido no debe perderse');
  assert.equal(queue.get(entry.id)?.attempts, 1);
  assert.match(queue.get(entry.id)?.lastError ?? '', /tardó demasiado/i);
  assert.equal(attempts.length, 1);
  assert.ok(receivedSignal, 'el fetch debe recibir una señal de timeout');
  assert.equal(receivedSignal?.aborted, true);
});

test('un 5xx conserva el alta para el próximo reintento', async () => {
  const entry = makeCreateEntry();
  const { queue, adapter } = makeAdapter([entry]);
  const { fetchImpl } = mockFetch(() => jsonResponse(503, { error: 'Servicio no disponible' }));

  const result = await processPendingOrderPuts(adapter, {
    fetchImpl,
    isOnline: () => true,
  });

  assert.equal(result.pending, 1);
  assert.equal(result.failed[0].retryable, true);
  assert.equal(result.failed[0].status, 503);
  assert.match(result.failed[0].message, /no disponible/i);
  assert.equal(queue.size, 1);
  assert.equal(queue.get(entry.id)?.attempts, 1);
});

test('un 400 de validación conserva el alta fallida y no la descarta', async () => {
  const entry = makeCreateEntry();
  const { queue, failures, adapter } = makeAdapter([entry]);
  const { fetchImpl } = mockFetch(() =>
    jsonResponse(400, { error: 'Datos inválidos: el cliente no existe' }),
  );

  const result = await processPendingOrderPuts(adapter, {
    fetchImpl,
    isOnline: () => true,
  });

  assert.equal(result.pending, 1);
  assert.equal(result.failed[0].retryable, false);
  assert.equal(result.failed[0].status, 400);
  assert.equal(result.failed[0].kind, 'create');
  assert.equal(queue.size, 1, 'un 4xx no debe perder el pedido');
  assert.equal(queue.get(entry.id)?.status, 'failed');
  assert.equal(queue.get(entry.id)?.lastStatus, 400);
  assert.match(queue.get(entry.id)?.lastError ?? '', /cliente no existe/i);
  assert.equal(failures.length, 1);
});

test('una entrada fallida no se reenvía en el siguiente flush y no bloquea las pendientes', async () => {
  const failedEntry: PendingOrderRequest = {
    ...makeCreateEntry('uuid-failed', 1),
    status: 'failed',
    lastError: 'Datos inválidos: el cliente no existe',
    lastStatus: 400,
    lastAttemptAt: 10,
  };
  const pendingEntry = makeCreateEntry('uuid-pending', 2);
  const { queue, adapter } = makeAdapter([failedEntry, pendingEntry]);
  const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, { success: true }));

  const result = await processPendingOrderPuts(adapter, {
    fetchImpl,
    isOnline: () => true,
  });

  assert.equal(calls.length, 1, 'sólo se envía la entrada pendiente');
  assert.match(String(calls[0].init?.body), /uuid-pending/);
  assert.equal(result.synced, 1);
  assert.equal(result.pending, 1, 'la fallida sigue contando en la cola');
  assert.equal(queue.has(failedEntry.id), true);
  assert.equal(queue.get(failedEntry.id)?.status, 'failed');
  assert.equal(queue.has(pendingEntry.id), false);
});

test('un alta fallida se vuelca al borrador de /orders/new con cliente, líneas y descuentos', () => {
  const entry = makeCreateEntry();
  const draft = buildOrderDraftFromQueueEntry(entry, {
    salesperson: 'e2e-vendedor',
    knownClients: [{ _id: clientId, code: 'CLI-1', name: 'Farmacia E2E' }],
  });

  assert.ok(draft);
  assert.equal(draft.selectedClient?._id, clientId);
  assert.equal(draft.selectedClient?.name, 'Farmacia E2E');
  assert.equal(draft.salesperson, 'e2e-vendedor');
  assert.deepEqual(draft.quantities, { '507f1f77bcf86cd799439022': 2 });
  assert.deepEqual(draft.itemDiscounts, { '507f1f77bcf86cd799439022': 5 });
  assert.equal(draft.invoiceType, 'A');
  assert.equal(draft.paymentCondition, 'contado');
});

test('la cola real conserva el fallo, permite resetearlo y el logout borra sólo las fallidas', async () => {
  await clearPendingOrderRequests();

  const entry = await enqueuePendingOrderCreate({
    clientRequestId: 'integration-failed',
    body: makeCreateEntry('integration-failed').body,
    clientName: 'Farmacia E2E',
    total: 1500,
  });
  await markPendingOrderRequestFailed(entry.id, 'El cliente fue dado de baja', 400);

  const stored = await getPendingOrderRequests();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'failed');
  assert.equal(stored[0].lastStatus, 400);
  assert.match(stored[0].lastError ?? '', /dado de baja/i);
  assert.equal(stored[0].clientName, 'Farmacia E2E');
  assert.equal(stored[0].total, 1500);
  assert.equal(typeof stored[0].lastAttemptAt, 'number');

  // Un flush automático no toca la entrada fallida.
  const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, { success: true }));
  const result = await processPendingOrderPuts(
    {
      list: getPendingOrderRequests,
      remove: deletePendingOrderRequest,
      markAttempt: markPendingOrderRequestAttempt,
      markFailed: markPendingOrderRequestFailed,
    },
    { fetchImpl, isOnline: () => true },
  );

  assert.equal(calls.length, 0);
  assert.equal(result.pending, 1);
  assert.equal((await getPendingOrderRequests())[0].status, 'failed');

  // "Reintentar" del usuario la vuelve a habilitar.
  await resetPendingOrderRequest(entry.id);
  const reset = await getPendingOrderRequests();
  assert.equal(reset[0].status, 'pending');
  assert.equal(reset[0].lastError, undefined);
  assert.equal(reset[0].lastStatus, undefined);

  // Un nuevo rechazo queda fallido y el logout lo elimina.
  await markPendingOrderRequestFailed(entry.id, 'Sigue inválido', 422);
  await clearFailedPendingOrderRequests();
  assert.deepEqual(await getPendingOrderRequests(), []);

  await clearPendingOrderRequests();
});

test('un 401 conserva el pedido para reintentar después de iniciar sesión', async () => {
  const { queue, adapter } = makeAdapter([makeUpdateEntry()]);
  const { fetchImpl } = mockFetch(() => jsonResponse(401, { error: 'Sesión requerida' }));

  const result = await processPendingOrderPuts(adapter, {
    fetchImpl,
    isOnline: () => true,
  });

  assert.equal(result.pending, 1);
  assert.equal(result.failed[0].retryable, true);
  assert.equal(result.failed[0].status, 401);
  assert.equal(queue.size, 1);
});

test('sin conexión no se intenta fetch y se informa la cantidad pendiente', async () => {
  const { queue, adapter } = makeAdapter([makeCreateEntry()]);
  let fetched = false;
  const fetchImpl = (async () => {
    fetched = true;
    return jsonResponse(200);
  }) as typeof fetch;

  const result = await processPendingOrderPuts(adapter, {
    fetchImpl,
    isOnline: () => false,
  });

  assert.equal(fetched, false);
  assert.equal(result.skippedOffline, true);
  assert.equal(result.pending, 1);
  assert.equal(queue.size, 1);
});

test('un doble flush concurrente no envía dos veces la misma entrada', async () => {
  const entry = makeCreateEntry();
  const { queue, adapter } = makeAdapter([entry]);
  const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, { success: true }));

  const [first, second] = await Promise.all([
    processPendingOrderPuts(adapter, { fetchImpl, isOnline: () => true }),
    processPendingOrderPuts(adapter, { fetchImpl, isOnline: () => true }),
  ]);

  assert.equal(first, second, 'ambos llamadores comparten la misma promesa');
  assert.equal(calls.length, 1, 'sólo debe haber un POST');
  assert.equal(first.synced, 1);
  assert.equal(queue.size, 0);
});

test('una entrada legacy de la v1 sin kind/method se procesa como PUT', async () => {
  // La v1 guardaba sólo orderId/url/body; una pestaña con la base vieja abierta
  // puede entregar esta forma aunque el schema ya esté en v2.
  const legacyEntry = {
    orderId,
    url: `/api/orders/${orderId}`,
    body: { status: 'facturacion', version: 3, items: [] },
    createdAt: 1,
    updatedAt: 1,
    attempts: 0,
  };
  const queue = new Map<string, unknown>([[orderId, legacyEntry]]);
  const adapter: OrderQueueAdapter = {
    async list() {
      return [...queue.values()] as unknown as PendingOrderRequest[];
    },
    async remove(id) {
      queue.delete(id);
    },
    async markAttempt() {},
    async markFailed() {},
  };
  const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, { success: true }));

  const result = await processPendingOrderPuts(adapter, {
    fetchImpl,
    isOnline: () => true,
  });

  assert.equal(result.synced, 1);
  assert.equal(calls[0].init?.method, 'PUT');
  assert.equal(result.syncedOrderIds[0], orderId);
  assert.equal(queue.size, 0);
});

test('procesa altas y PUT en el orden de la cola y se detiene en el primer fallo transitorio', async () => {
  const firstId = '507f1f77bcf86cd799439012';
  const secondClientRequestId = 'uuid-request-2';
  const thirdClientRequestId = 'uuid-request-3';
  const entries = [
    makeCreateEntry('uuid-request-1', 1),
    makeUpdateEntry(firstId, 2),
    makeCreateEntry(secondClientRequestId, 3),
    makeCreateEntry(thirdClientRequestId, 4),
  ];
  const { queue, adapter } = makeAdapter(entries);

  let call = 0;
  const { calls, fetchImpl } = mockFetch(() => {
    call += 1;
    return call <= 2
      ? jsonResponse(200, { success: true })
      : jsonResponse(500, { error: 'Error interno' });
  });

  const result = await processPendingOrderPuts(adapter, {
    fetchImpl,
    isOnline: () => true,
  });

  assert.deepEqual(
    calls.map((request) => `${request.init?.method} ${request.url}`),
    ['POST /api/orders', `PUT /api/orders/${firstId}`, 'POST /api/orders'],
    'debe respetar createdAt y no adelantar entradas nuevas',
  );
  assert.equal(result.synced, 2);
  assert.deepEqual(result.syncedRequestIds, [entries[0].id, entries[1].id]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].clientRequestId, secondClientRequestId);
  assert.equal(result.failed[0].retryable, true);
  assert.equal(result.pending, 2);
  assert.equal(queue.has(entries[0].id), false);
  assert.equal(queue.has(entries[1].id), false);
  assert.equal(queue.has(entries[2].id), true);
  assert.equal(queue.has(entries[3].id), true, 'el resto no se envía tras un 5xx');
});

test('el service worker escucha Background Sync y avisa a las pestañas', async () => {
  const sw = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');

  assert.match(sw, /ORDER_PUT_SYNC_TAG = 'sgi-order-put-sync'/);
  assert.match(sw, /ORDER_PUT_SYNC_MESSAGE = 'SGI_ORDER_PUT_SYNC'/);
  assert.match(sw, /addEventListener\('sync'/);
  assert.match(sw, /client\.postMessage\(\{ type: ORDER_PUT_SYNC_MESSAGE \}\)/);
});

test('el indicador abre el detalle de la cola y el logout borra las entradas fallidas', async () => {
  const indicator = await readFile(
    new URL('../components/OfflineSyncIndicator.tsx', import.meta.url),
    'utf8',
  );

  assert.match(indicator, /addEventListener\('focus'/);
  assert.match(indicator, /addEventListener\('online'/);
  assert.match(indicator, /addEventListener\('visibilitychange'/);
  assert.match(indicator, /Cola de sincronización/);
  assert.match(indicator, /Restaurar en borrador/);
  assert.match(indicator, /Restaurar control en el pedido/);
  assert.match(indicator, /Abrir pedido actual/);
  assert.match(indicator, /Descartar/);

  const pwaClient = await readFile(new URL('../lib/pwa-client.ts', import.meta.url), 'utf8');
  assert.match(pwaClient, /clearFailedPendingOrderRequests/);
  assert.match(pwaClient, /PICKING_AUTOSAVE_STORAGE_KEY/);
  assert.match(pwaClient, /PENDING_ORDER_COMMENT_STORAGE_KEY/);
  assert.match(indicator, /Edición de borrador #/);

  const editPage = await readFile(
    new URL('../app/orders/[id]/edit/page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(editPage, /requireCurrentRolePage\(\['admin', 'vendedor'\]\)/);
});

test('un PUT de edición de borrador (mode: draft-edit) se distingue de picking y puede restaurarse en la clave de edición aislada', async () => {
  await clearPendingOrderRequests();

  const draftEditOrderId = '507f1f77bcf86cd799439088';
  const entry = await enqueuePendingOrderPut({
    orderId: draftEditOrderId,
    url: `/api/orders/${draftEditOrderId}`,
    body: {
      mode: 'draft-edit',
      version: 2,
      items: [
        {
          productId: '507f1f77bcf86cd799439022',
          requestedQuantity: 4,
          customDiscount: 10,
        },
      ],
      invoiceType: 'B',
      paymentCondition: 'otro',
      paymentConditionDetail: 'Cheque a 30 días',
      comment: 'Ajuste offline de borrador',
    },
    clientName: 'Farmacia E2E',
    total: 4200,
  });

  assert.equal(isDraftEditQueueEntry(entry), true);
  assert.equal(isDraftEditQueueEntry(makeUpdateEntry()), false);

  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    values,
  };

  // Borrador de alta nueva activo en el mismo dispositivo.
  const createDraft = createOrderDraft({
    quantities: { 'prod-alta': 1 },
    selectedClient: null,
    salesperson: 'e2e-vendedor',
    comment: 'Alta en curso',
    itemDiscounts: {},
    generalDiscount: 0,
    brandDiscounts: {},
    invoiceType: 'A',
    paymentCondition: 'contado',
    paymentConditionDetail: '',
  });
  saveOrderDraft(storage, createDraft, 'user-vendedor');

  const restored = restoreOrderDraftFromQueueEntry(
    {
      userId: 'user-vendedor',
      salesperson: 'e2e-vendedor',
      knownClients: [{ _id: clientId, code: 'CLI-1', name: 'Farmacia E2E' }],
      storage,
    },
    entry,
  );
  assert.equal(restored, true);

  // Se guardó en la clave aislada de edición sin pisar el alta nueva.
  assert.ok(storage.getItem(getOrderDraftStorageKey('user-vendedor', draftEditOrderId)));
  assert.deepEqual(loadOrderDraft(storage, 'user-vendedor')?.quantities, { 'prod-alta': 1 });

  const editDraft = loadOrderDraft(storage, 'user-vendedor', {
    orderId: draftEditOrderId,
    version: 3,
  });
  assert.ok(editDraft);
  assert.deepEqual(editDraft.quantities, { '507f1f77bcf86cd799439022': 4 });
  assert.deepEqual(editDraft.itemDiscounts, { '507f1f77bcf86cd799439022': 10 });
  assert.equal(editDraft.invoiceType, 'B');
  assert.equal(editDraft.paymentCondition, 'otro');
  assert.equal(editDraft.paymentConditionDetail, 'Cheque a 30 días');
  assert.equal(editDraft.comment, 'Ajuste offline de borrador');

  // Al cerrar sesión se limpian los drafts (alta y edición), picking y comentarios.
  savePickingAutosave(storage, {
    orderId: draftEditOrderId,
    userId: 'user-vendedor',
    version: 3,
    savedAt: Date.now(),
    items: {
      'linea-1': { verifiedQty: 4, controlled: true, pendingReason: '' },
    },
  });
  savePendingOrderComment(storage, {
    orderId: draftEditOrderId,
    userId: 'user-vendedor',
    text: 'Pendiente de enviar',
    savedAt: Date.now(),
  });

  await clearUserOfflineData({ userId: 'user-vendedor', clearPendingOrders: true, storage });

  assert.equal(storage.getItem(getOrderDraftStorageKey('user-vendedor')), null);
  assert.equal(storage.getItem(getOrderDraftStorageKey('user-vendedor', draftEditOrderId)), null);
  assert.equal(
    storage.getItem(getPickingAutosaveStorageKey('user-vendedor', draftEditOrderId)),
    null,
  );
  assert.equal(
    storage.getItem(getPendingOrderCommentStorageKey('user-vendedor', draftEditOrderId)),
    null,
  );
  assert.deepEqual(await getPendingOrderRequests(), []);
});
