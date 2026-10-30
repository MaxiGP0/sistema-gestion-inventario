/**
 * Pruebas de los efectos secundarios best-effort del pedido:
 * - POST /api/orders responde sin esperar la creación de la notificación
 *   (after() de Next, con fallback no bloqueante fuera del request scope).
 * - POST /api/orders y PUT /api/orders/[id] siguen respondiendo 200 aunque
 *   Notification.create falle después de persistir el pedido.
 * - El fallo queda registrado en console.error (no se filtra al cliente).
 *
 * No requiere base de datos: stubs de los modelos y conexión mongoose falsa,
 * igual que el resto de la suite.
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
import { User } from '../models/User';
import { authRequest } from './test-auth-utils';

// VAPID habilitado para que el dispatcher intente resolver destinatarios; el
// envío en sí falla en User.find y debe quedar como best-effort.
process.env.VAPID_PUBLIC_KEY =
  'BJfjRf0IB-6KwI9OcCfyCuD44Gckk6maPLzWBhogU3xQ-lq1u8996lfThKoCTIOjj9gzTOYqm-BuE2az8ohvrpA';
process.env.VAPID_PRIVATE_KEY = 'gTwnjCzYxMWH4LCP7iRwthab9FL38tRpIyNlv8nel30';
process.env.VAPID_SUBJECT = 'mailto:test@example.com';

const oid = () => new mongoose.Types.ObjectId().toString();

const clientId = oid();
const productId = oid();
const orderId = oid();

let orderDoc: any;
let saveCalls = 0;
let notificationAttempts = 0;
let loggedErrors: unknown[][] = [];

let POST: (request: Request) => Promise<Response>;
let PUT: (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const fakeClient: any = {
  _id: clientId,
  code: 'CLI-1',
  name: 'Cliente Demo',
  generalDiscount: 0,
  brandDiscounts: [],
};

const fakeProduct: any = {
  _id: productId,
  code: 'P-1',
  name: 'Producto Demo',
  price: 100,
  brandId: null,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

const failingNotification = async () => {
  notificationAttempts += 1;
  throw new Error('Notification.create caído');
};

let notificationCreateImpl: (doc: any) => Promise<any> = failingNotification;

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  orderDoc = {
    _id: orderId,
    status: 'borrador',
    clientId: { name: 'Cliente Demo' },
    items: [
      {
        _id: oid(),
        productId,
        productCode: 'P-1',
        productName: 'Producto Demo',
        brandName: 'Marca Demo',
        unitPrice: 100,
        requestedQuantity: 2,
        verifiedQuantity: 2,
        isPending: false,
        itemDiscount: 0,
        lineTotal: 200,
      },
    ],
    subtotal: 200,
    totalDiscount: 0,
    finalTotal: 200,
    comments: [],
    version: 0,
    save: async () => {
      saveCalls += 1;
      orderDoc.version += 1;
    },
  };

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
  mock.method(Notification as any, 'create', (doc: any) => notificationCreateImpl(doc));

  // El dispatcher de push arranca por User.find; hacerlo fallar simula que el
  // Web Push no pudo resolver destinatarios sin tocar la creación del pedido.
  mock.method(User as any, 'find', () => {
    throw new Error('User.find caído en Web Push');
  });

  mock.method(console, 'error', (...args: unknown[]) => {
    loggedErrors.push(args);
  });

  ({ POST } = await import('../app/api/orders/route'));
  ({ PUT } = await import('../app/api/orders/[id]/route'));
});

after(() => mock.restoreAll());

const createOrderRequest = () =>
  authRequest(
    'http://localhost/api/orders',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        createdBy: 'vendedor',
        items: [{ productId, requestedQuantity: 2 }],
        invoiceType: 'A',
        paymentCondition: 'contado',
      }),
    },
    'vendedor',
  );

test('POST /api/orders no espera la notificación para responder', async () => {
  notificationAttempts = 0;
  loggedErrors = [];

  let releaseNotification: (() => void) | undefined;
  let notificationPending = true;

  notificationCreateImpl = (doc: any) => {
    notificationAttempts += 1;
    return new Promise((resolve) => {
      releaseNotification = () => {
        notificationPending = false;
        resolve({ _id: oid(), read: false, ...doc });
      };
    });
  };

  const response = await Promise.race([
    POST(createOrderRequest()),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
  ]);

  assert.notEqual(response, 'timeout', 'POST no debe quedar esperando la notificación');
  assert.equal((response as Response).status, 200);

  const payload = await (response as Response).json();
  assert.equal(payload.success, true);

  await waitFor(
    () => notificationAttempts === 1,
    'la notificación debe intentarse después de la respuesta',
  );
  assert.equal(notificationPending, true, 'la respuesta no debe esperar a que resuelva');

  releaseNotification?.();
  await waitFor(() => !notificationPending, 'la notificación pendiente debe poder resolverse');
});

test('POST /api/orders responde 200 si falla la notificación del borrador', async () => {
  notificationAttempts = 0;
  loggedErrors = [];
  notificationCreateImpl = failingNotification;

  const response = await POST(createOrderRequest());
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.success, true);

  await waitFor(
    () => notificationAttempts === 1,
    'el helper debe intentar crear la notificación después de responder',
  );
  await waitFor(
    () =>
      loggedErrors.some((args) =>
        args.some((arg) => String(arg).includes('notificación de pedido')),
      ),
    'el fallo debe quedar en console.error',
  );
});

test('POST /api/orders responde 200 si falla el Web Push después de persistir', async () => {
  notificationAttempts = 0;
  loggedErrors = [];
  notificationCreateImpl = async (doc: any) => {
    notificationAttempts += 1;
    return { _id: oid(), ...doc };
  };

  const response = await POST(createOrderRequest());
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.success, true);

  await waitFor(
    () => notificationAttempts === 1,
    'la notificación debe persistirse antes de intentar el push',
  );
  await waitFor(
    () =>
      loggedErrors.some((args) =>
        args.some((arg) => String(arg).includes('dispatcher de Web Push')),
      ),
    'el fallo del push debe quedar en console.error sin afectar la respuesta',
  );
});

test('PUT /api/orders/[id] responde 200 si falla la notificación a facturación', async () => {
  notificationAttempts = 0;
  saveCalls = 0;
  loggedErrors = [];
  notificationCreateImpl = failingNotification;
  orderDoc.status = 'borrador';
  orderDoc.version = 0;

  const response = await PUT(
    authRequest(
      `http://localhost/api/orders/${orderId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'facturacion', version: 0 }),
      },
      'controlador',
    ),
    { params: Promise.resolve({ id: orderId }) },
  );
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.success, true);
  assert.equal(payload.order.status, 'facturacion');
  assert.equal(saveCalls, 1, 'el pedido debe quedar guardado');

  await waitFor(
    () => notificationAttempts === 1,
    'el helper debe intentar crear la notificación después de responder',
  );
  await waitFor(
    () =>
      loggedErrors.some((args) =>
        args.some((arg) => String(arg).includes('notificación de pedido')),
      ),
    'el fallo debe quedar en console.error',
  );
});
