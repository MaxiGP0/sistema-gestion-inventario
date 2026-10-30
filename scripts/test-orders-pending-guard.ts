/**
 * Pruebas del guard de facturación (PUT /api/orders/[id]):
 * - Un pedido con ítems pendientes (marcados o verificados por debajo de lo
 *   pedido) no puede pasar a "facturacion", ni con items ni solo con status.
 * - El picking completo sigue funcionando: se guarda y auto-transiciona a
 *   "facturacion" (con su notificación) o a "paralizado" si quedan faltantes.
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa y se
 * stubbean los statics de Order/Notification antes de importar el route handler,
 * igual que en test-notifications-cleanup.ts.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { Notification } from '../models/Notification';
import { Order } from '../models/Order';
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId().toString();

let orderDoc: any;
let saveCalls = 0;
let notificationsCreated: any[] = [];

let PUT: (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const baseItems = () => [
  {
    _id: oid(),
    productId: oid(),
    unitPrice: 100,
    requestedQuantity: 3,
    verifiedQuantity: 3,
    isPending: false,
    itemDiscount: 10,
    lineTotal: 270,
  },
];

/** Pedido falso con la misma forma que devuelve Order.findById(...).populate(). */
const seedOrder = ({ status = 'borrador', items = baseItems() } = {}) => {
  orderDoc = {
    _id: oid(),
    status,
    items,
    subtotal: 300,
    totalDiscount: 30,
    finalTotal: 270,
    comments: [],
    clientId: { name: 'Cliente Test' },
    version: 0,
    save: async () => {
      saveCalls += 1;
      orderDoc.version = (orderDoc.version ?? 0) + 1;
    },
  };
};

const putOrder = (body: object) =>
  PUT(
    authRequest(
      'http://localhost/api/orders/pedido-test',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: orderDoc.version, ...body }),
      },
      'controlador',
    ),
    { params: Promise.resolve({ id: orderDoc._id }) },
  );

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Order as any, 'findById', () => ({
    populate: async () => orderDoc,
  }));
  mock.method(Notification as any, 'create', async (doc: any) => {
    notificationsCreated.push(doc);
    return doc;
  });

  ({ PUT } = await import('../app/api/orders/[id]/route'));
});

after(() => mock.restoreAll());

test('status "facturacion" sin items se rechaza si el pedido tiene faltantes', async () => {
  seedOrder({
    items: [{ ...baseItems()[0], verifiedQuantity: 1 }], // 1 de 3: pendiente
  });
  saveCalls = 0;
  notificationsCreated = [];

  const response = await putOrder({ status: 'facturacion' });
  const payload = await response.json();

  assert.equal(
    response.status,
    409,
    `se esperaba 409 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /facturación/);
  assert.equal(saveCalls, 0, 'no debe guardarse un pedido que no puede facturarse');
  assert.equal(notificationsCreated.length, 0);
});

test('status "facturacion" sin items se rechaza si el ítem está marcado pendiente', async () => {
  seedOrder({
    items: [{ ...baseItems()[0], isPending: true }], // cantidad completa, pero marcado pendiente
  });
  saveCalls = 0;
  notificationsCreated = [];

  const response = await putOrder({ status: 'facturacion' });
  const payload = await response.json();

  assert.equal(
    response.status,
    409,
    `se esperaba 409 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /facturación/);
  assert.equal(saveCalls, 0);
  assert.equal(notificationsCreated.length, 0);
});

test('status "facturacion" sin items se rechaza si la cantidad no fue verificada', async () => {
  seedOrder({
    items: [{ ...baseItems()[0], verifiedQuantity: undefined } as any], // sin cantidad verificada
  });
  saveCalls = 0;
  notificationsCreated = [];

  const response = await putOrder({ status: 'facturacion' });
  const payload = await response.json();

  assert.equal(
    response.status,
    409,
    `se esperaba 409 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /facturación/);
  assert.equal(saveCalls, 0);
  assert.equal(notificationsCreated.length, 0);
});

test('items con faltantes y status "facturacion" explícito se rechazan', async () => {
  seedOrder();
  saveCalls = 0;
  notificationsCreated = [];

  const item = orderDoc.items[0];
  const response = await putOrder({
    items: [{ _id: item._id, verifiedQuantity: 1, isPending: false }],
    status: 'facturacion',
  });
  const payload = await response.json();

  assert.equal(
    response.status,
    409,
    `se esperaba 409 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /facturación/);
  assert.equal(saveCalls, 0);
  assert.equal(notificationsCreated.length, 0);
});

test('items marcados pendientes con status "facturacion" explícito se rechazan', async () => {
  seedOrder();
  saveCalls = 0;
  notificationsCreated = [];

  const item = orderDoc.items[0];
  const response = await putOrder({
    items: [{ _id: item._id, verifiedQuantity: 3, isPending: true }],
    status: 'facturacion',
  });
  const payload = await response.json();

  assert.equal(
    response.status,
    409,
    `se esperaba 409 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /facturación/);
  assert.equal(saveCalls, 0);
  assert.equal(notificationsCreated.length, 0);
});

test('items sin cantidad verificada y status "facturacion" explícito se rechazan', async () => {
  seedOrder();
  saveCalls = 0;
  notificationsCreated = [];

  const item = orderDoc.items[0];
  const response = await putOrder({
    items: [{ _id: item._id, requestedQuantity: 3 }], // sin verifiedQuantity
    status: 'facturacion',
  });
  const payload = await response.json();

  assert.equal(
    response.status,
    409,
    `se esperaba 409 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /facturación/);
  assert.equal(saveCalls, 0);
  assert.equal(notificationsCreated.length, 0);
});

test('picking completo sin status auto-transiciona a "facturacion" y notifica', async () => {
  seedOrder();
  saveCalls = 0;
  notificationsCreated = [];

  const item = orderDoc.items[0];
  const response = await putOrder({
    items: [{ _id: item._id, verifiedQuantity: 3, isPending: false }],
  });
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.success, true);
  assert.equal(orderDoc.status, 'facturacion');
  assert.equal(saveCalls, 1);
  assert.equal(notificationsCreated.length, 1);
  assert.equal(notificationsCreated[0].targetRole, 'billing');
});

test('picking con faltantes sin status auto-transiciona a "paralizado"', async () => {
  seedOrder();
  saveCalls = 0;
  notificationsCreated = [];

  const item = orderDoc.items[0];
  const response = await putOrder({
    items: [{ _id: item._id, verifiedQuantity: 1, isPending: false }],
  });
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(orderDoc.status, 'paralizado');
  assert.equal(saveCalls, 1);
  assert.equal(notificationsCreated.length, 1);
  assert.equal(notificationsCreated[0].targetRole, 'vendor');
  assert.equal(notificationsCreated[0].title, 'Pedido Paralizado en Depósito');
});

test('status "paralizado" sigue permitido con faltantes (no se sobre-bloquea)', async () => {
  seedOrder({
    items: [{ ...baseItems()[0], verifiedQuantity: 1 }],
  });
  saveCalls = 0;

  const response = await putOrder({ status: 'paralizado' });
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(orderDoc.status, 'paralizado');
  assert.equal(saveCalls, 1);
});
