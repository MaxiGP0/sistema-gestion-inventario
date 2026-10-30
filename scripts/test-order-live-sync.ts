/**
 * Pruebas de la lógica de actualización en vivo de pedidos:
 * - Detección de versión remota: aplicar, ignorar o marcar como vencida
 *   cuando hay cambios locales.
 * - Throttle de refrescos: una ráfaga de alertas produce un solo refresh cada
 *   1,5 s y cancelar no deja timers vivos.
 * - Puente SSE: el evento republicado por la campana conserva rol y orderId
 *   para que el detalle sólo reaccione al pedido abierto.
 *
 * No requiere DOM ni base de datos. Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ORDER_FOCUS_REFRESH_AFTER_MS,
  ORDER_REFRESH_THROTTLE_MS,
  canAutoMergeRemoteOrder,
  createRefreshScheduler,
  decideRemoteOrderUpdate,
  orderNotificationTargetsOrder,
  orderVersion,
  shouldRefreshAfterVisibility,
} from '../lib/order-live-sync';
import {
  emitOrderNotification,
  subscribeToOrderNotifications,
  type OrderNotificationEventDetail,
} from '../lib/order-notification-events';

const ORDER_ID = '64b7f0c2a1b2c3d4e5f60718';

test('orderVersion normaliza versiones ausentes o inválidas a 0', () => {
  assert.equal(orderVersion({ version: 7 }), 7);
  assert.equal(orderVersion({ version: 0 }), 0);
  assert.equal(orderVersion({}), 0);
  assert.equal(orderVersion(null), 0);
  assert.equal(orderVersion({ version: -1 }), 0);
  assert.equal(orderVersion({ version: Number.NaN }), 0);
});

test('decideRemoteOrderUpdate aplica sólo versiones nuevas sin cambios locales', () => {
  assert.equal(
    decideRemoteOrderUpdate({ localVersion: 3, remoteVersion: 4, hasLocalChanges: false }),
    'apply',
  );
  assert.equal(
    decideRemoteOrderUpdate({ localVersion: 3, remoteVersion: 4, hasLocalChanges: true }),
    'stale',
  );
  assert.equal(
    decideRemoteOrderUpdate({ localVersion: 4, remoteVersion: 4, hasLocalChanges: true }),
    'ignore',
  );
  assert.equal(
    decideRemoteOrderUpdate({ localVersion: 4, remoteVersion: 3, hasLocalChanges: false }),
    'ignore',
  );
  assert.equal(
    decideRemoteOrderUpdate({
      localVersion: undefined,
      remoteVersion: 1,
      hasLocalChanges: false,
    }),
    'apply',
  );
});

test('el foco sólo revalida después de una ausencia mayor a 30 s', () => {
  assert.equal(shouldRefreshAfterVisibility(0), false);
  assert.equal(shouldRefreshAfterVisibility(ORDER_FOCUS_REFRESH_AFTER_MS), false);
  assert.equal(shouldRefreshAfterVisibility(ORDER_FOCUS_REFRESH_AFTER_MS + 1), true);
});

const autoMergeItem = () => ({
  _id: 'item-1',
  productId: { _id: 'product-1' },
  requestedQuantity: 3,
  verifiedQuantity: 2,
  isPending: false,
  pendingReason: 'Faltante parcial',
  postControl: 'pendiente',
});

const autoMergeOrder = (overrides: Record<string, unknown> = {}) => ({
  _id: ORDER_ID,
  status: 'facturacion',
  archived: false,
  version: 4,
  comments: [{ text: 'Comentario de otro usuario', author: 'facturacion' }],
  items: [autoMergeItem()],
  ...overrides,
});

test('canAutoMergeRemoteOrder acepta sólo cambios de comentarios y versión', () => {
  const local = autoMergeOrder({
    version: 3,
    comments: [{ text: 'Comentario local' }],
  });
  const remote = autoMergeOrder({ version: 4 });

  assert.equal(canAutoMergeRemoteOrder(local, remote), true);

  // El mismo pedido puede venir con productId poblado o plano: se comparan ids.
  assert.equal(
    canAutoMergeRemoteOrder(
      autoMergeOrder({ items: [{ ...autoMergeItem(), productId: 'product-1' }] }),
      autoMergeOrder(),
    ),
    true,
  );

  // `archived` ausente equivale a false en los pedidos históricos.
  assert.equal(
    canAutoMergeRemoteOrder(autoMergeOrder({ archived: undefined }), autoMergeOrder()),
    true,
  );
});

test('canAutoMergeRemoteOrder rechaza cambios de estado, archivado o líneas', () => {
  const local = autoMergeOrder({ version: 3 });

  assert.equal(canAutoMergeRemoteOrder(local, autoMergeOrder({ status: 'entregado' })), false);
  assert.equal(canAutoMergeRemoteOrder(local, autoMergeOrder({ archived: true })), false);
  assert.equal(canAutoMergeRemoteOrder(local, autoMergeOrder({ items: [] })), false);

  const itemChanges: Array<Record<string, unknown>> = [
    { _id: 'item-2' },
    { productId: 'product-2' },
    { requestedQuantity: 4 },
    { verifiedQuantity: 3 },
    { isPending: true },
    { pendingReason: 'Sin stock' },
    { postControl: 'ok' },
  ];

  for (const change of itemChanges) {
    assert.equal(
      canAutoMergeRemoteOrder(
        local,
        autoMergeOrder({ items: [{ ...autoMergeItem(), ...change }] }),
      ),
      false,
      `un cambio en ${Object.keys(change)[0]} no debe auto-fusionarse`,
    );
  }

  assert.equal(canAutoMergeRemoteOrder(null, autoMergeOrder()), false);
  assert.equal(canAutoMergeRemoteOrder(autoMergeOrder(), undefined), false);
});

test('el throttle agrupa ráfagas y respeta la ventana de 1,5 s', () => {
  let now = 0;
  let nextTimerId = 1;
  let refreshes = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const schedule = (callback: () => void, delayMs: number) => {
    const timerId = nextTimerId;
    nextTimerId += 1;
    timers.set(timerId, { at: now + delayMs, callback });
    return timerId as unknown as ReturnType<typeof setTimeout>;
  };

  const cancelSchedule = (handle: ReturnType<typeof setTimeout>) => {
    timers.delete(handle as unknown as number);
  };

  const advance = (milliseconds: number) => {
    const target = now + milliseconds;

    while (true) {
      let next: [number, { at: number; callback: () => void }] | null = null;

      for (const entry of timers) {
        if (entry[1].at > target) continue;
        if (!next || entry[1].at < next[1].at) next = entry;
      }

      if (!next) break;

      timers.delete(next[0]);
      now = next[1].at;
      next[1].callback();
    }

    now = target;
  };

  const scheduler = createRefreshScheduler({
    delayMs: ORDER_REFRESH_THROTTLE_MS,
    now: () => now,
    schedule,
    cancelSchedule,
    onRefresh: () => {
      refreshes += 1;
    },
  });

  scheduler.request();
  scheduler.request();
  assert.equal(timers.size, 1, 'la ráfaga debe compartir un único timer');

  advance(ORDER_REFRESH_THROTTLE_MS - 1);
  assert.equal(refreshes, 0);

  scheduler.request();
  advance(1);
  assert.equal(refreshes, 1);

  scheduler.request();
  advance(ORDER_REFRESH_THROTTLE_MS - 1);
  assert.equal(refreshes, 1);
  advance(1);
  assert.equal(refreshes, 2, 'el segundo refresh respeta la ventana');

  scheduler.request();
  scheduler.cancel();
  advance(ORDER_REFRESH_THROTTLE_MS * 3);
  assert.equal(refreshes, 2, 'cancelar descarta el refresh pendiente');
});

test('el evento SSE conserva el pedido para que el detalle lo filtre', () => {
  const globalWithWindow = globalThis as unknown as { window?: Window };
  const previousWindow = globalWithWindow.window;
  const target = new EventTarget();
  globalWithWindow.window = target as unknown as Window;

  try {
    const received: OrderNotificationEventDetail[] = [];
    const unsubscribe = subscribeToOrderNotifications((detail) => received.push(detail));

    emitOrderNotification({ targetRole: 'deposit', orderId: ORDER_ID });

    assert.deepEqual(received, [{ targetRole: 'deposit', orderId: ORDER_ID }]);
    assert.equal(orderNotificationTargetsOrder(received[0], ORDER_ID), true);
    assert.equal(orderNotificationTargetsOrder(received[0], 'otro-pedido'), false);
    assert.equal(orderNotificationTargetsOrder({ orderId: null }, ORDER_ID), false);

    unsubscribe();
  } finally {
    if (previousWindow) globalWithWindow.window = previousWindow;
    else delete globalWithWindow.window;
  }
});
