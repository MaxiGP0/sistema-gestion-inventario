/**
 * Pruebas de idempotencia del alta de pedidos (`POST /api/orders`):
 * - La primera petición crea el borrador y guarda `clientRequestId`.
 * - Un reintento con la misma clave del mismo usuario devuelve 200 con el
 *   pedido existente y `deduplicated: true`, sin insertar ni notificar de nuevo.
 * - Si dos requests concurrentes chocan contra el índice único, el perdedor
 *   busca el documento ganador y también devuelve 200.
 * - Sin clave (clientes viejos) el alta sigue creando pedidos independientes.
 * - Una clave inválida se rechaza con 400 antes de tocar la base.
 *
 * No requiere base de datos: se usa una conexión mongoose falsa y stubs de los
 * modelos, igual que el resto de la suite.
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
import { MAX_CLIENT_REQUEST_ID_LENGTH } from '../lib/order-request-id';
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId().toString();

const SELLER_ID = '0000000000000000000000a1';
const OTHER_USER_ID = '0000000000000000000000b2';
const clientId = oid();
const productId = oid();
const brandId = oid();

const client = {
  code: 'CLI-1',
  name: 'Cliente Demo',
  generalDiscount: 0,
  brandDiscounts: [],
};

const products = [
  {
    _id: productId,
    code: 'P-1',
    name: 'Producto Demo',
    price: 100,
    brandId: { _id: brandId, name: 'Marca Demo' },
    active: true,
  },
];

const baseBody = {
  clientId,
  items: [{ productId, requestedQuantity: 2 }],
  invoiceType: 'A',
  paymentCondition: 'contado',
  comment: 'Alta idempotente',
};

let createdOrders: any[] = [];
let notificationsCreated = 0;
let byKey = new Map<string, any>();
let raceMode = false;
let findOneCalls = 0;

const keyOf = (doc: any) => `${doc.createdById}:${doc.clientRequestId}`;

function resetState() {
  createdOrders = [];
  notificationsCreated = 0;
  byKey = new Map();
  raceMode = false;
  findOneCalls = 0;
}

let POST: (request: Request) => Promise<Response>;

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Order as any, 'findOne', (filter: any) => ({
    lean: async () => {
      if (raceMode && findOneCalls++ === 0) return null;
      return byKey.get(`${filter.createdById}:${filter.clientRequestId}`) ?? null;
    },
  }));

  mock.method(Order as any, 'create', async (doc: any) => {
    const key = keyOf(doc);

    if (doc.clientRequestId && raceMode && !byKey.has(key)) {
      // Simula que otro request ganó la carrera justo antes de este insert.
      const winner = { _id: oid(), ...doc };
      byKey.set(key, winner);
      createdOrders.push(winner);
      throw Object.assign(new Error('E11000 duplicate key error'), {
        code: 11000,
        keyPattern: { createdById: 1, clientRequestId: 1 },
      });
    }

    if (doc.clientRequestId && byKey.has(key)) {
      throw Object.assign(new Error('E11000 duplicate key error'), {
        code: 11000,
        keyPattern: { createdById: 1, clientRequestId: 1 },
      });
    }

    const created = { _id: oid(), ...doc };
    createdOrders.push(created);
    if (doc.clientRequestId) byKey.set(key, created);
    return created;
  });

  mock.method(Client as any, 'findById', () => ({
    select: () => client,
  }));

  mock.method(Product as any, 'find', () => {
    const chain: any = {
      select: () => chain,
      populate: () => chain,
      lean: async () => products,
    };
    return chain;
  });

  mock.method(Notification as any, 'create', async (doc: any) => {
    notificationsCreated += 1;
    return { _id: oid(), ...doc };
  });

  ({ POST } = await import('../app/api/orders/route'));
});

after(() => mock.restoreAll());

const createRequest = (
  overrides: Record<string, unknown> = {},
  role: 'admin' | 'vendedor' = 'vendedor',
  userId = SELLER_ID,
) =>
  POST(
    authRequest(
      'http://localhost/api/orders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, ...overrides }),
      },
      role,
      userId,
    ),
  );

test('el reintento con la misma clave devuelve el pedido existente sin duplicar', async () => {
  resetState();
  const key = '7f0f8f5e-7a4d-4a6e-8f1a-2b3c4d5e6f70';

  const first = await createRequest({ clientRequestId: key });
  const firstPayload = await first.json();

  assert.equal(first.status, 200, JSON.stringify(firstPayload));
  assert.equal(firstPayload.success, true);
  assert.equal(firstPayload.deduplicated, undefined);
  assert.equal(firstPayload.order.clientRequestId, key);
  assert.equal(createdOrders.length, 1);
  assert.equal(notificationsCreated, 1);

  const second = await createRequest({ clientRequestId: key });
  const secondPayload = await second.json();

  assert.equal(second.status, 200, JSON.stringify(secondPayload));
  assert.equal(secondPayload.deduplicated, true);
  assert.equal(secondPayload.order._id, firstPayload.order._id);
  assert.equal(createdOrders.length, 1, 'el reintento no debe volver a insertar');
  assert.equal(notificationsCreated, 1, 'tampoco debe repetir la notificación');
});

test('si el índice único rechaza la carrera, se devuelve el pedido ganador', async () => {
  resetState();
  raceMode = true;

  const response = await createRequest({ clientRequestId: 'carrera-uuid-1' });
  const payload = await response.json();

  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.deduplicated, true);
  assert.equal(createdOrders.length, 1);
  assert.equal(notificationsCreated, 0, 'el perdedor no debe notificar un pedido ajeno');
});

test('sin clientRequestId el alta sigue siendo compatible y crea cada pedido', async () => {
  resetState();

  const first = await createRequest();
  const second = await createRequest();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(createdOrders.length, 2);
  assert.notEqual((await first.json()).order._id, (await second.json()).order._id);
});

test('la misma clave de distintos usuarios no comparte pedido', async () => {
  resetState();
  const key = 'uuid-compartido-entre-usuarios';

  const first = await createRequest({ clientRequestId: key }, 'vendedor', SELLER_ID);
  const second = await createRequest({ clientRequestId: key }, 'admin', OTHER_USER_ID);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).deduplicated, undefined);
  assert.equal(createdOrders.length, 2);
});

test('una clave de idempotencia inválida responde 400 antes de crear', async () => {
  resetState();

  const response = await createRequest({
    clientRequestId: 'x'.repeat(MAX_CLIENT_REQUEST_ID_LENGTH + 1),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.match(payload.error, /clave de idempotencia/i);
  assert.equal(createdOrders.length, 0);
});
