/**
 * Pruebas del estado de notificaciones por usuario:
 * - DELETE /api/orders/[id] elimina las notificaciones del pedido y sus
 *   estados de lectura por usuario.
 * - PUT /api/notifications sin id respeta el targetRole y solo crea/actualiza
 *   filas de NotificationRead del usuario autenticado.
 * - PUT /api/notifications con id marca solo esa notificación para ese usuario.
 * - DELETE /api/notifications con id descarta (oculta) solo para ese usuario.
 * - DELETE /api/notifications sin id descarta las leídas de la bandeja solo
 *   para ese usuario, sin borrar la notificación compartida.
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa y se
 * stubbean los statics de Order/Notification/NotificationRead antes de importar
 * los route handlers, igual que en test-sse-events.ts.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { Notification } from '../models/Notification';
import { NotificationRead } from '../models/NotificationRead';
import { Order } from '../models/Order';
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId();
const TEST_USER_ID = '000000000000000000000001';

const orderId = oid();
const orderIdStr = orderId.toString();
const notificationIdA = oid();
const notificationIdB = oid();
const notificationDocs = [{ _id: notificationIdA }, { _id: notificationIdB }];

type BulkCall = { query: any; update: any };
type SingleReadCall = BulkCall & { options: any };
type AggregateCall = { pipeline: any[] };

let orderExists = true;
let notificationFindQueries: any[] = [];
let notificationAggregateCalls: AggregateCall[] = [];
let notificationCountQueries: any[] = [];
let deletedNotificationQueries: any[] = [];
let deletedNotificationReadQueries: any[] = [];
let singleReadCalls: SingleReadCall[] = [];
let dismissReadCalls: BulkCall[] = [];

let orderDelete: (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let notificationsDelete: (request: Request) => Promise<Response>;
let PUT: (request: Request) => Promise<Response>;

const deleteOrder = (id: string) =>
  // Hard-delete de pedidos: solo admin.
  orderDelete(authRequest(`http://localhost/api/orders/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });

const deleteNotifications = (query = '') =>
  notificationsDelete(
    authRequest(`http://localhost/api/notifications${query}`, { method: 'DELETE' }),
  );

const markNotifications = (body: unknown, role: 'admin' | 'controlador' | 'billing' = 'admin') =>
  PUT(
    authRequest(
      'http://localhost/api/notifications',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      role,
    ),
  );

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Order as any, 'findByIdAndDelete', async (id: string) =>
    orderExists ? { _id: new mongoose.Types.ObjectId(id), status: 'borrador' } : null,
  );

  mock.method(Notification as any, 'find', (query: any) => {
    notificationFindQueries.push(query);
    const chain: any = {
      select: () => chain,
      sort: () => chain,
      limit: () => chain,
      lean: async () => notificationDocs,
    };
    return chain;
  });
  mock.method(Notification as any, 'aggregate', (pipeline: any[]) => {
    notificationAggregateCalls.push({ pipeline });
    return Promise.resolve([]);
  });
  mock.method(Notification as any, 'countDocuments', async (query: any) => {
    notificationCountQueries.push(query);
    return notificationDocs.length;
  });
  mock.method(Notification as any, 'deleteMany', async (query: any) => {
    deletedNotificationQueries.push(query);
    return { acknowledged: true, deletedCount: 1 };
  });

  mock.method(NotificationRead as any, 'deleteMany', async (query: any) => {
    deletedNotificationReadQueries.push(query);
    return { acknowledged: true, deletedCount: 1 };
  });
  mock.method(
    NotificationRead as any,
    'findOneAndUpdate',
    async (query: any, update: any, options: any) => {
      singleReadCalls.push({ query, update, options });
      return { _id: oid(), ...update };
    },
  );
  mock.method(NotificationRead as any, 'updateMany', async (query: any, update: any) => {
    dismissReadCalls.push({ query, update });
    return { acknowledged: true, modifiedCount: 1 };
  });

  ({ DELETE: orderDelete } = await import('../app/api/orders/[id]/route'));
  ({ PUT, DELETE: notificationsDelete } = await import('../app/api/notifications/route'));
});

after(() => mock.restoreAll());

const resetCaptures = () => {
  notificationFindQueries = [];
  notificationAggregateCalls = [];
  notificationCountQueries = [];
  deletedNotificationQueries = [];
  deletedNotificationReadQueries = [];
  singleReadCalls = [];
  dismissReadCalls = [];
};

test('DELETE /api/orders/[id] borra notificaciones y estados de lectura del pedido', async () => {
  orderExists = true;
  resetCaptures();

  const response = await deleteOrder(orderIdStr);
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.success, true);
  assert.deepEqual(notificationFindQueries, [{ orderId }]);
  assert.deepEqual(deletedNotificationReadQueries, [
    { notificationId: { $in: [notificationIdA, notificationIdB] } },
  ]);
  assert.deepEqual(deletedNotificationQueries, [{ orderId }]);
});

test('DELETE /api/orders/[id] inexistente responde 404 y no toca las notificaciones', async () => {
  orderExists = false;
  resetCaptures();

  const response = await deleteOrder(oid().toString());

  assert.equal(response.status, 404);
  assert.equal(notificationFindQueries.length, 0);
  assert.equal(deletedNotificationQueries.length, 0);
  assert.equal(deletedNotificationReadQueries.length, 0);
});

test('PUT /api/notifications sin id filtra por targetRole y usa un $merge acotado', async () => {
  resetCaptures();

  const response = await markNotifications({ read: true, targetRole: 'deposit' }, 'controlador');
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.success, true);
  assert.equal(
    notificationFindQueries.length,
    0,
    'no debe cargar ids de notificaciones en el proceso',
  );
  assert.equal(notificationCountQueries.length, 1);
  assert.deepEqual(notificationCountQueries[0].targetRole, { $in: ['deposit', 'all'] });
  assert.ok(
    notificationCountQueries[0].createdAt.$gte instanceof Date,
    'el conteo debe estar acotado por la ventana de "marcar todas"',
  );

  assert.equal(notificationAggregateCalls.length, 1);
  const pipeline = notificationAggregateCalls[0].pipeline;
  assert.deepEqual(pipeline[0].$match.targetRole, { $in: ['deposit', 'all'] });
  assert.ok(pipeline[0].$match.createdAt.$gte instanceof Date);

  const merge = pipeline.find((stage) => stage.$merge)?.$merge;
  assert.ok(merge, 'debe existir la etapa $merge');
  assert.deepEqual(merge.on, ['userId', 'notificationId']);
  assert.deepEqual(merge.whenMatched, [
    { $set: { readAt: '$$new.readAt', updatedAt: '$$new.updatedAt' } },
  ]);
  assert.equal(merge.whenNotMatched, 'insert');
  assert.equal(singleReadCalls.length, 0);
});

test('PUT /api/notifications sin id respeta las bandejas de facturación y global', async () => {
  resetCaptures();

  await markNotifications({ read: true, targetRole: 'billing' }, 'billing');
  assert.deepEqual(notificationAggregateCalls[0].pipeline[0].$match.targetRole, {
    $in: ['billing', 'all'],
  });

  resetCaptures();
  await markNotifications({ read: true, targetRole: 'all' }, 'admin');
  assert.equal(notificationAggregateCalls[0].pipeline[0].$match.targetRole, undefined);
});

test('PUT /api/notifications con id marca solo esa notificación para el usuario', async () => {
  resetCaptures();

  const response = await markNotifications({ id: notificationIdA.toString(), read: true });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.success, true);
  assert.equal(singleReadCalls.length, 1);
  assert.deepEqual(singleReadCalls[0].query, {
    userId: TEST_USER_ID,
    notificationId: notificationIdA.toString(),
  });
  assert.deepEqual(singleReadCalls[0].options, { upsert: true });
  assert.ok(singleReadCalls[0].update.$set.readAt instanceof Date);
});

test('PUT /api/notifications con read=false desmarca solo esa notificación', async () => {
  resetCaptures();

  const response = await markNotifications({ id: notificationIdA.toString(), read: false });

  assert.equal(response.status, 200);
  assert.deepEqual(deletedNotificationReadQueries, [
    { userId: TEST_USER_ID, notificationId: notificationIdA.toString() },
  ]);
  assert.equal(singleReadCalls.length, 0);
});

test('DELETE /api/notifications?targetRole=billing descarta las leídas solo para el usuario', async () => {
  resetCaptures();

  const response = await deleteNotifications('?targetRole=billing');

  assert.equal(response.status, 200);
  assert.deepEqual(notificationFindQueries, [{ targetRole: { $in: ['billing', 'all'] } }]);
  assert.equal(dismissReadCalls.length, 1);
  assert.deepEqual(dismissReadCalls[0].query, {
    userId: TEST_USER_ID,
    notificationId: { $in: [notificationIdA, notificationIdB] },
    readAt: { $ne: null },
    dismissedAt: null,
  });
  assert.ok(dismissReadCalls[0].update.$set.dismissedAt instanceof Date);
  assert.equal(deletedNotificationQueries.length, 0, 'no debe borrar la notificación compartida');
});

test('DELETE /api/notifications?targetRole=all limpia las leídas de todas las bandejas', async () => {
  resetCaptures();

  const response = await deleteNotifications('?targetRole=all');

  assert.equal(response.status, 200);
  assert.deepEqual(notificationFindQueries, [{}]);
  assert.equal(dismissReadCalls.length, 1);
});

test('DELETE /api/notifications con id descarta solo esa notificación para el usuario', async () => {
  resetCaptures();

  const response = await deleteNotifications(`?id=${notificationIdA}`);

  assert.equal(response.status, 200);
  assert.equal(singleReadCalls.length, 1);
  assert.deepEqual(singleReadCalls[0].query, {
    userId: TEST_USER_ID,
    notificationId: notificationIdA.toString(),
  });
  assert.deepEqual(singleReadCalls[0].options, { upsert: true });
  assert.ok(singleReadCalls[0].update.$set.readAt instanceof Date);
  assert.ok(singleReadCalls[0].update.$set.dismissedAt instanceof Date);
  assert.equal(deletedNotificationQueries.length, 0);
});
