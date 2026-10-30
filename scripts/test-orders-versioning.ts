/**
 * Pruebas del control de versión optimista en PUT /api/orders/[id]:
 * - La versión enviada debe coincidir con la del pedido; si otro operario
 *   guardó antes, responde 409 con un mensaje claro y no muta nada.
 * - Un save() que pierde la carrera (VersionError de Mongoose) también se
 *   traduce a 409, no a 500.
 * - La versión es obligatoria en el body y se incrementa al guardar.
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa y se
 * stubbean los statics de Order/Notification antes de importar el handler.
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
let saveError: Error | null = null;
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
    itemDiscount: 0,
    lineTotal: 300,
  },
];

const seedOrder = ({ version = 3, status = 'borrador' } = {}) => {
  orderDoc = {
    _id: oid(),
    status,
    items: baseItems(),
    subtotal: 300,
    totalDiscount: 0,
    finalTotal: 300,
    comments: [],
    clientId: { name: 'Cliente Test' },
    version,
    save: async () => {
      saveCalls += 1;
      if (saveError) throw saveError;
      // Mongoose incrementa el versionKey al guardar.
      orderDoc.version += 1;
    },
  };
};

const putOrder = (body: object) =>
  PUT(
    authRequest(
      `http://localhost/api/orders/${orderDoc._id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

test('PUT con versión vieja responde 409 con mensaje claro y no guarda', async () => {
  seedOrder({ version: 3 });
  saveCalls = 0;
  saveError = null;
  notificationsCreated = [];

  const response = await putOrder({ status: 'paralizado', version: 2 });
  const payload = await response.json();

  assert.equal(
    response.status,
    409,
    `se esperaba 409 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.code, 'ORDER_VERSION_CONFLICT');
  assert.match(payload.error, /conflicto de versión/i);
  assert.match(payload.error, /modificado por otro usuario/i);
  assert.equal(payload.version, 3, 'debe informar la versión actual para recargar');
  assert.equal(saveCalls, 0, 'no debe guardarse un pedido desactualizado');
  assert.equal(notificationsCreated.length, 0);
});

test('PUT con la versión actual guarda, incrementa la versión y la devuelve', async () => {
  seedOrder({ version: 3 });
  saveCalls = 0;
  saveError = null;
  notificationsCreated = [];

  const response = await putOrder({ status: 'paralizado', version: 3 });
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.success, true);
  assert.equal(saveCalls, 1);
  assert.equal(payload.order.version, 4, 'la respuesta debe traer la versión siguiente');
});

test('PUT firma el comentario con la sesión e ignora author/role del body', async () => {
  seedOrder({ version: 3 });
  saveCalls = 0;
  notificationsCreated = [];

  const response = await putOrder({
    comment: 'Comentario operativo',
    author: 'Autor Falsificado',
    role: 'admin',
    version: 3,
  });
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(saveCalls, 1);

  const comment = orderDoc.comments.at(-1);
  assert.equal(comment.text, 'Comentario operativo');
  assert.equal(comment.author, 'test-controlador');
  assert.equal(comment.role, 'controlador');
});

test('PUT sin version responde 400 (la versión es obligatoria)', async () => {
  seedOrder({ version: 0 });
  saveCalls = 0;

  const response = await putOrder({ status: 'paralizado' });
  const payload = await response.json();

  assert.equal(
    response.status,
    400,
    `se esperaba 400 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /versión/i);
  assert.equal(saveCalls, 0);
});

test('un VersionError de Mongoose (carrera entre find y save) responde 409, no 500', async () => {
  seedOrder({ version: 0 });
  saveCalls = 0;
  notificationsCreated = [];

  const versionError = new Error('No matching document found for id');
  versionError.name = 'VersionError';
  saveError = versionError;

  const response = await putOrder({ status: 'paralizado', version: 0 });
  const payload = await response.json();

  assert.equal(
    response.status,
    409,
    `se esperaba 409 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.code, 'ORDER_VERSION_CONFLICT');
  assert.match(payload.error, /conflicto de versión/i);
  assert.equal(
    notificationsCreated.length,
    0,
    'no debe notificar una actualización que no se guardó',
  );
});
