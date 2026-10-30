/**
 * Pruebas del canal SSE:
 * - /api/events exige sesión y deriva la bandeja del rol.
 * - lib/sse.ts registra clientes, entrega el comentario inicial, difunde
 *   eventos filtrados por bandeja con id, reproduce lo perdido al reconectar
 *   con Last-Event-ID, emite heartbeat y limpia al desconectarse.
 * - El límite por usuario/IP cierra la conexión más vieja.
 * - POST /api/orders y PUT /api/orders/[id] emiten el evento SSE cuando crean
 *   notificaciones (borrador -> depósito; verificado -> facturación) y no
 *   emiten nada cuando la actualización no genera notificación.
 *
 * No requiere base de datos ni servidor: se deja una conexión mongoose cacheada
 * falsa y se stubbean los statics de los modelos antes de importar los route
 * handlers, igual que en test-orders-list-payload.ts.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { Client } from '../models/Client';
import { Notification } from '../models/Notification';
import { Order } from '../models/Order';
import { Product } from '../models/Product';
import {
  SSE_HEARTBEAT_MS,
  SSE_MAX_CONNECTIONS_PER_IP,
  SSE_MAX_CONNECTIONS_PER_USER,
  broadcastEvent,
  connectedSseClientCount,
  createEventStream,
  type CreateEventStreamOptions,
} from '../lib/sse';
import { notificationInboxForRole, notificationMatchesInbox } from '../lib/notification-inbox';
import {
  ORDER_NOTIFICATION_EVENT,
  emitOrderNotification,
  orderNotificationMatchesTray,
  parseOrderNotificationEventDetail,
  subscribeToOrderNotifications,
  type OrderNotificationEventDetail,
} from '../lib/order-notification-events';
import { GET as getEvents } from '../app/api/events/route';
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId();

const clientId = oid();
const productId = oid();
const orderId = oid();
const orderIdStr = orderId.toString();

/** Lee eventos SSE completos (delimitados por línea en blanco) de un stream. */
class SseReader {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private waitForChunk() {
    if (!this.pending) {
      this.pending = this.reader.read().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  /**
   * Devuelve el próximo evento o null si no llegó nada dentro de `timeoutMs`.
   * Si vence el timeout, el read pendiente se reutiliza en la próxima llamada.
   */
  async nextEvent(timeoutMs = 1000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const end = this.buffer.indexOf('\n\n');
      if (end !== -1) {
        const event = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return event;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;

      const result = await Promise.race([
        this.waitForChunk(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (result === null) return null;
      if (result.done) {
        throw new Error('El stream SSE se cerró antes de recibir el evento esperado');
      }
      this.buffer += this.decoder.decode(result.value, { stream: true });
    }
  }

  async cancel() {
    await this.reader.cancel();
  }
}

let streamSequence = 0;

/** Abre un stream con usuario/IP únicos salvo que el test pida compartirlos. */
const openSse = (options: Partial<CreateEventStreamOptions> = {}) => {
  streamSequence += 1;
  const sequence = streamSequence;

  return new SseReader(
    createEventStream({
      userId: options.userId ?? `sse-user-${sequence}`,
      username: options.username,
      inbox: options.inbox ?? 'all',
      ip: options.ip ?? `10.0.${(sequence >> 8) & 255}.${sequence & 255}`,
      lastEventId: options.lastEventId,
    }).getReader(),
  );
};

/** Extrae `id:` y el JSON de `data:` de un evento SSE. */
function parseSseEvent(chunk: string | null): { id: string; data: Record<string, unknown> } {
  assert.ok(chunk, 'se esperaba un evento SSE y no llegó ninguno');
  const lines = chunk.split('\n');
  const idLine = lines.find((line) => line.startsWith('id: '));
  const dataLine = lines.find((line) => line.startsWith('data: '));

  assert.ok(idLine, `el evento debe tener id: ${chunk}`);
  assert.ok(dataLine, `el evento debe tener data: ${chunk}`);

  return { id: idLine.slice(4), data: JSON.parse(dataLine.slice(6)) };
}

let POST: (request: Request) => Promise<Response>;
let PUT: (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let createdNotification: any = null;

const fakeClient: any = {
  _id: clientId,
  name: 'Cliente Demo',
  generalDiscount: 0,
  brandDiscounts: [],
};
const fakeProduct: any = { _id: productId, price: 100, brandId: null };

const orderDoc: any = {
  _id: orderId,
  status: 'borrador',
  clientId: { name: 'Cliente Demo' },
  items: [],
  comments: [],
  version: 0,
  save: async () => {
    orderDoc.version = (orderDoc.version ?? 0) + 1;
  },
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Client as any, 'findById', () => ({ select: () => fakeClient }));
  mock.method(Product as any, 'find', () => {
    const chain: any = {
      select: () => chain,
      populate: () => chain,
      lean: async () => [fakeProduct],
    };
    return chain;
  });
  mock.method(Order as any, 'create', async (doc: any) => ({ _id: orderId, ...doc }));
  mock.method(Order as any, 'findById', () => ({ populate: async () => orderDoc }));
  mock.method(Notification as any, 'create', async (doc: any) => {
    createdNotification = { _id: oid(), read: false, ...doc };
    return createdNotification;
  });

  ({ POST } = await import('../app/api/orders/route'));
  ({ PUT } = await import('../app/api/orders/[id]/route'));
});

after(() => mock.restoreAll());

test('GET /api/events responde 401 sin cookie de sesión', async () => {
  const response = await getEvents(new Request('http://localhost/api/events'));
  assert.equal(response.status, 401);

  const payload = await response.json();
  assert.equal(payload.error, 'Sesión requerida');
});

test('la bandeja SSE se deriva del rol y el evento corresponde a su inbox', () => {
  assert.equal(notificationInboxForRole('controlador'), 'deposit');
  assert.equal(notificationInboxForRole('billing'), 'billing');
  assert.equal(notificationInboxForRole('admin'), 'all');
  assert.equal(notificationInboxForRole('vendedor'), 'vendor');

  assert.equal(notificationMatchesInbox('deposit', 'deposit'), true);
  assert.equal(notificationMatchesInbox('deposit', 'billing'), false);
  assert.equal(notificationMatchesInbox('billing', 'billing'), true);
  assert.equal(notificationMatchesInbox('billing', 'deposit'), false);
  assert.equal(notificationMatchesInbox('deposit', 'all'), true);
  assert.equal(notificationMatchesInbox('all', 'deposit'), true);
});

test('NotificationsBell ignora eventos SSE de otro inbox antes de refrescar', () => {
  // Mismo chequeo que hace el handler `source.onmessage`: un evento de
  // facturación no debe disparar la consulta de una campana filtrada por
  // depósito (ni al revés).
  assert.equal(notificationMatchesInbox('deposit', 'billing'), false);
  assert.equal(notificationMatchesInbox('billing', 'deposit'), false);
  assert.equal(notificationMatchesInbox('deposit', 'all'), true);
  assert.equal(notificationMatchesInbox('all', 'billing'), true);
});

test('el evento de bandeja valida rol/pedido y respeta los comodines de inbox', () => {
  assert.deepEqual(
    parseOrderNotificationEventDetail({ targetRole: 'billing', orderId: orderIdStr }),
    {
      targetRole: 'billing',
      orderId: orderIdStr,
    },
  );
  assert.deepEqual(parseOrderNotificationEventDetail({ targetRole: 'deposit', orderId: 123 }), {
    targetRole: 'deposit',
    orderId: null,
  });
  assert.equal(parseOrderNotificationEventDetail({ targetRole: 'otro' }), null);
  assert.equal(parseOrderNotificationEventDetail(null), null);

  assert.equal(orderNotificationMatchesTray('deposit', 'deposit'), true);
  assert.equal(orderNotificationMatchesTray('billing', 'deposit'), false);
  assert.equal(orderNotificationMatchesTray('deposit', 'all'), true);
  assert.equal(orderNotificationMatchesTray('all', 'deposit'), true);
});

test('NotificationsBell republica el SSE como CustomEvent para las bandejas', () => {
  const globalWithWindow = globalThis as unknown as { window?: Window };
  const previousWindow = globalWithWindow.window;
  const target = new EventTarget();
  globalWithWindow.window = target as unknown as Window;

  try {
    const received: OrderNotificationEventDetail[] = [];
    const unsubscribe = subscribeToOrderNotifications((detail) => received.push(detail));

    emitOrderNotification({ targetRole: 'billing', orderId: orderIdStr });
    assert.deepEqual(received, [{ targetRole: 'billing', orderId: orderIdStr }]);

    // Un detalle inválido no debe llegar a la bandeja.
    target.dispatchEvent(
      new CustomEvent(ORDER_NOTIFICATION_EVENT, { detail: { targetRole: 'inventado' } }),
    );
    assert.equal(received.length, 1);

    unsubscribe();
    emitOrderNotification({ targetRole: 'deposit', orderId: null });
    assert.equal(received.length, 1, 'después de desuscribirse no se reciben eventos');
  } finally {
    if (previousWindow) globalWithWindow.window = previousWindow;
    else delete globalWithWindow.window;
  }
});

test('createEventStream registra al cliente, difunde eventos y limpia al cancelar', async () => {
  const initial = connectedSseClientCount();
  const sse = openSse();

  // Comentario inicial: confirma la conexión sin disparar 'message' en EventSource.
  assert.equal(await sse.nextEvent(1000), ': connected');
  assert.equal(connectedSseClientCount(), initial + 1);

  const eventId = broadcastEvent({
    type: 'notification',
    targetRole: 'deposit',
    orderId: orderIdStr,
  });
  const event = parseSseEvent(await sse.nextEvent(1000));

  assert.equal(event.id, eventId);
  assert.deepEqual(event.data, {
    type: 'notification',
    targetRole: 'deposit',
    orderId: orderIdStr,
    eventId,
  });

  await sse.cancel();
  assert.equal(connectedSseClientCount(), initial);

  // Un broadcast posterior a la desconexión no debe romper ni entregar a nadie.
  broadcastEvent({ type: 'notification', targetRole: 'billing' });
});

test('broadcastEvent entrega solo a la bandeja correspondiente y a la global', async () => {
  const deposit = openSse({ inbox: 'deposit' });
  const billing = openSse({ inbox: 'billing' });
  const all = openSse({ inbox: 'all' });

  for (const reader of [deposit, billing, all]) {
    assert.equal(await reader.nextEvent(1000), ': connected');
  }

  const depositId = broadcastEvent({ type: 'notification', targetRole: 'deposit' });
  const depositEvent = parseSseEvent(await deposit.nextEvent(1000));
  const depositForAll = parseSseEvent(await all.nextEvent(1000));
  assert.equal(depositEvent.id, depositId);
  assert.equal(depositForAll.id, depositId);
  assert.equal(await billing.nextEvent(50), null, 'facturación no debe recibir depósito');

  const billingId = broadcastEvent({ type: 'notification', targetRole: 'billing' });
  const billingEvent = parseSseEvent(await billing.nextEvent(1000));
  const billingForAll = parseSseEvent(await all.nextEvent(1000));
  assert.equal(billingEvent.id, billingId);
  assert.equal(billingForAll.id, billingId);
  assert.equal(await deposit.nextEvent(50), null, 'depósito no debe recibir facturación');

  const globalId = broadcastEvent({ type: 'notification', targetRole: 'all' });
  for (const reader of [deposit, billing, all]) {
    const event = parseSseEvent(await reader.nextEvent(1000));
    assert.equal(event.id, globalId, 'las alertas globales llegan a todas las bandejas');
  }

  await Promise.all([deposit.cancel(), billing.cancel(), all.cancel()]);
});

test('los eventos de vendedor solo llegan a ese usuario y a admin', async () => {
  const seller = openSse({ userId: 'seller-1', username: 'vendedor-1', inbox: 'vendor' });
  const otherSeller = openSse({ userId: 'seller-2', username: 'vendedor-2', inbox: 'vendor' });
  const admin = openSse({ userId: 'admin-1', username: 'admin', inbox: 'all' });
  const deposit = openSse({ userId: 'deposit-1', inbox: 'deposit' });

  for (const reader of [seller, otherSeller, admin, deposit]) {
    assert.equal(await reader.nextEvent(1000), ': connected');
  }

  const eventId = broadcastEvent({
    type: 'notification',
    targetRole: 'vendor',
    targetUserId: 'seller-1',
    targetUsername: 'vendedor-1',
  });

  assert.equal(parseSseEvent(await seller.nextEvent(1000)).id, eventId);
  assert.equal(parseSseEvent(await admin.nextEvent(1000)).id, eventId);
  assert.equal(await otherSeller.nextEvent(50), null, 'otro vendedor no debe recibirlo');
  assert.equal(await deposit.nextEvent(50), null, 'depósito no debe recibirlo');

  // Pedidos históricos sin createdById: el fallback por username sigue siendo
  // privado y no se difunde a la bandeja completa de vendedores.
  const legacyEventId = broadcastEvent({
    type: 'notification',
    targetRole: 'vendor',
    targetUsername: 'vendedor-2',
  });
  assert.equal(parseSseEvent(await otherSeller.nextEvent(1000)).id, legacyEventId);
  assert.equal(parseSseEvent(await admin.nextEvent(1000)).id, legacyEventId);
  assert.equal(await seller.nextEvent(50), null, 'el otro vendedor no debe recibirlo');

  await Promise.all([seller.cancel(), otherSeller.cancel(), admin.cancel(), deposit.cancel()]);
});

test('al reconectar con Last-Event-ID reproduce solo lo perdido de esa bandeja', async () => {
  const firstId = `replay-first-${streamSequence}`;
  const secondId = `replay-second-${streamSequence}`;
  const billingId = `replay-billing-${streamSequence}`;
  const thirdId = `replay-third-${streamSequence}`;

  broadcastEvent({ type: 'notification', targetRole: 'deposit', eventId: firstId });
  broadcastEvent({ type: 'notification', targetRole: 'deposit', eventId: secondId });
  broadcastEvent({ type: 'notification', targetRole: 'billing', eventId: billingId });
  broadcastEvent({ type: 'notification', targetRole: 'deposit', eventId: thirdId });

  const deposit = openSse({ inbox: 'deposit', lastEventId: firstId });
  assert.equal(await deposit.nextEvent(1000), ': connected');
  assert.equal(parseSseEvent(await deposit.nextEvent(1000)).id, secondId);
  assert.equal(parseSseEvent(await deposit.nextEvent(1000)).id, thirdId);
  assert.equal(await deposit.nextEvent(50), null, 'no debe reproducir el evento de facturación');
  await deposit.cancel();

  // Aunque el id de partida sea de otra bandeja, el replay respeta el inbox.
  const billing = openSse({ inbox: 'billing', lastEventId: firstId });
  assert.equal(await billing.nextEvent(1000), ': connected');
  assert.equal(parseSseEvent(await billing.nextEvent(1000)).id, billingId);
  assert.equal(await billing.nextEvent(50), null);
  await billing.cancel();
});

test('limita las conexiones por usuario y cierra la más vieja', async () => {
  const initial = connectedSseClientCount();
  const userId = 'limit-user';
  const ip = '198.51.100.10';
  const readers: SseReader[] = [];

  for (let index = 0; index < SSE_MAX_CONNECTIONS_PER_USER; index += 1) {
    const reader = openSse({ userId, ip });
    assert.equal(await reader.nextEvent(1000), ': connected');
    readers.push(reader);
  }

  assert.equal(connectedSseClientCount(), initial + SSE_MAX_CONNECTIONS_PER_USER);

  const newest = openSse({ userId, ip });
  assert.equal(await newest.nextEvent(1000), ': connected');
  readers.push(newest);

  assert.equal(
    connectedSseClientCount(),
    initial + SSE_MAX_CONNECTIONS_PER_USER,
    'el total debe quedar en el límite',
  );

  const displaced = await readers[0].nextEvent(1000);
  assert.ok(displaced?.includes('event: connection-limit'), 'la más vieja recibe el aviso');
  assert.ok(displaced?.includes('"reason":"connection-limit"'));

  for (const reader of readers.slice(1)) {
    await reader.cancel();
  }
  assert.equal(connectedSseClientCount(), initial);
});

test('limita las conexiones por IP aunque sean usuarios distintos', async () => {
  const initial = connectedSseClientCount();
  const ip = '198.51.100.20';
  const readers: SseReader[] = [];

  for (let index = 0; index < SSE_MAX_CONNECTIONS_PER_IP; index += 1) {
    const reader = openSse({ userId: `ip-user-${index}`, ip });
    assert.equal(await reader.nextEvent(1000), ': connected');
    readers.push(reader);
  }

  const newest = openSse({ userId: 'ip-user-extra', ip });
  assert.equal(await newest.nextEvent(1000), ': connected');
  readers.push(newest);

  assert.equal(connectedSseClientCount(), initial + SSE_MAX_CONNECTIONS_PER_IP);

  const displaced = await readers[0].nextEvent(1000);
  assert.ok(displaced?.includes('event: connection-limit'), 'la IP más vieja recibe el aviso');

  for (const reader of readers.slice(1)) {
    await reader.cancel();
  }
  assert.equal(connectedSseClientCount(), initial);
});

test('el heartbeat mantiene el stream con un comentario cada SSE_HEARTBEAT_MS', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const sse = openSse();
    assert.equal(await sse.nextEvent(1000), ': connected');

    // A un milisegundo del intervalo todavía no debe llegar nada.
    mock.timers.tick(SSE_HEARTBEAT_MS - 1);
    assert.equal(await sse.nextEvent(20), null);

    // Cumplido el intervalo, llega el ping.
    mock.timers.tick(1);
    assert.equal(await sse.nextEvent(1000), ': ping');

    await sse.cancel();
  } finally {
    mock.timers.reset();
  }
});

test('POST /api/orders emite SSE a depósito al crear el borrador', async () => {
  createdNotification = null;
  const sse = openSse({ inbox: 'deposit' });
  assert.equal(await sse.nextEvent(1000), ': connected');

  const response = await POST(
    authRequest(
      'http://localhost/api/orders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: clientId.toString(),
          items: [{ productId: productId.toString(), requestedQuantity: 2 }],
          createdBy: 'vendedor',
          invoiceType: 'A',
          paymentCondition: 'contado',
        }),
      },
      'vendedor',
    ),
  );

  assert.equal(response.status, 200);
  await waitFor(
    () => createdNotification?.targetRole === 'deposit',
    'la notificación debe crearse después de responder',
  );

  const event = parseSseEvent(await sse.nextEvent(1000));
  assert.equal(event.id, String(createdNotification._id));
  assert.equal(event.data.targetRole, 'deposit');
  assert.equal(event.data.orderId, orderIdStr);

  await sse.cancel();
});

test('PUT /api/orders/[id] emite SSE a facturación al verificarse el pedido', async () => {
  createdNotification = null;
  const sse = openSse({ inbox: 'billing' });
  assert.equal(await sse.nextEvent(1000), ': connected');

  const response = await PUT(
    authRequest(
      `http://localhost/api/orders/${orderIdStr}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'facturacion', version: orderDoc.version }),
      },
      'controlador',
    ),
    { params: Promise.resolve({ id: orderIdStr }) },
  );

  assert.equal(response.status, 200);
  await waitFor(
    () => createdNotification?.targetRole === 'billing',
    'la notificación debe crearse después de responder',
  );
  assert.equal(String(createdNotification.orderId), orderIdStr);

  const event = parseSseEvent(await sse.nextEvent(1000));
  assert.equal(event.id, String(createdNotification._id));
  assert.equal(event.data.targetRole, 'billing');
  assert.equal(event.data.orderId, orderIdStr);

  // Un update sin notificación (solo comentario) no emite nada.
  const commentResponse = await PUT(
    authRequest(
      `http://localhost/api/orders/${orderIdStr}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment: 'Nota interna',
          author: 'operario',
          role: 'controlador',
          version: orderDoc.version,
        }),
      },
      'controlador',
    ),
    { params: Promise.resolve({ id: orderIdStr }) },
  );
  assert.equal(commentResponse.status, 200);
  assert.equal(await sse.nextEvent(50), null);

  await sse.cancel();
});
