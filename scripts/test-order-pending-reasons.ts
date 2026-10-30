/**
 * Pruebas del motivo/estado por línea (`pendingReason`) en pedidos:
 * - Se guarda cuando depósito marca la línea pendiente o controla de menos.
 * - Se limpia cuando la línea vuelve a quedar controlada por completo.
 * - Un ítem que depósito elimina no desaparece: queda como línea pendiente
 *   con motivo "Eliminado en depósito" para conservar la trazabilidad.
 * - Esa línea eliminada sigue bloqueando el pase a facturación.
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
import {
  PENDING_REASON_REMOVED,
  PENDING_REASON_UNCONTROLLED,
  resolveItemValues,
} from '../lib/order-totals';
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId().toString();

let orderDoc: any;
let saveCalls = 0;
let notificationsCreated: any[] = [];

let PUT: (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const makeItem = (overrides: Record<string, unknown> = {}) => ({
  _id: oid(),
  productId: oid(),
  productCode: 'P-1',
  productName: 'Producto Uno',
  brandName: 'Marca Uno',
  unitPrice: 100,
  requestedQuantity: 3,
  verifiedQuantity: 3,
  isPending: false,
  itemDiscount: 10,
  lineTotal: 270,
  ...overrides,
});

const seedOrder = ({ status = 'borrador', items = [makeItem()] } = {}) => {
  orderDoc = {
    _id: oid(),
    status,
    items,
    subtotal: 300,
    totalDiscount: 30,
    finalTotal: 270,
    comments: [],
    clientId: { name: 'Cliente Test', generalDiscount: 0, brandDiscounts: [] },
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
      `http://localhost/api/orders/${orderDoc._id}`,
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

test('resolveItemValues registra el motivo pendiente y lo limpia al controlar la línea', () => {
  const existing = {
    _id: oid(),
    productId: oid(),
    unitPrice: 100,
    requestedQuantity: 4,
    itemDiscount: 0,
  };

  const custom = resolveItemValues(existing, {
    _id: String(existing._id),
    verifiedQuantity: 0,
    isPending: true,
    pendingReason: 'Sin stock en proveedor',
  });
  assert.equal(custom.pendingReason, 'Sin stock en proveedor');
  assert.equal(custom.leavesPending, true);

  const defaultPending = resolveItemValues(existing, {
    _id: String(existing._id),
    verifiedQuantity: 0,
    isPending: true,
  });
  assert.equal(defaultPending.pendingReason, PENDING_REASON_UNCONTROLLED);

  const partial = resolveItemValues(existing, {
    _id: String(existing._id),
    verifiedQuantity: 2,
    isPending: false,
  });
  assert.equal(partial.pendingReason, 'Faltante: 2 de 4 controlados');

  const partialWithoutReason = resolveItemValues(existing, {
    _id: String(existing._id),
    verifiedQuantity: 2,
    isPending: false,
    pendingReason: '',
  });
  assert.equal(
    partialWithoutReason.pendingReason,
    'Faltante: 2 de 4 controlados',
    'un motivo vacío debe completarse con el faltante automático',
  );

  const pendingWithoutReason = resolveItemValues(existing, {
    _id: String(existing._id),
    verifiedQuantity: 0,
    isPending: true,
    pendingReason: '',
  });
  assert.equal(pendingWithoutReason.pendingReason, PENDING_REASON_UNCONTROLLED);

  const restored = resolveItemValues(
    { ...existing, isPending: true, pendingReason: 'Sin stock en proveedor' },
    { _id: String(existing._id), verifiedQuantity: 4, isPending: false },
  );
  assert.equal(restored.leavesPending, false);
  assert.equal(restored.pendingReason, undefined, 'al controlar todo se limpia el motivo');
});

test('PUT guarda el pendingReason cuando depósito marca la línea pendiente', async () => {
  seedOrder();
  saveCalls = 0;
  notificationsCreated = [];

  const item = orderDoc.items[0];
  const response = await putOrder({
    items: [
      {
        _id: item._id,
        verifiedQuantity: 0,
        isPending: true,
        pendingReason: 'Sin stock en depósito',
      },
    ],
    status: 'paralizado',
  });
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(saveCalls, 1);
  assert.equal(orderDoc.items[0].isPending, true);
  assert.equal(orderDoc.items[0].pendingReason, 'Sin stock en depósito');
  assert.equal(orderDoc.items[0].lineTotal, 0);
  assert.equal(orderDoc.status, 'paralizado');
});

test('PUT completa el motivo automático cuando depósito lo envía vacío', async () => {
  const partial = makeItem({ requestedQuantity: 5 });
  const uncontrolled = makeItem({
    productCode: 'P-2',
    productName: 'Producto Dos',
    requestedQuantity: 2,
  });
  seedOrder({ items: [partial, uncontrolled] });
  saveCalls = 0;
  notificationsCreated = [];

  const response = await putOrder({
    items: [
      {
        _id: partial._id,
        verifiedQuantity: 3,
        isPending: false,
        pendingReason: '',
      },
      {
        _id: uncontrolled._id,
        verifiedQuantity: 0,
        isPending: true,
        pendingReason: '',
      },
    ],
    status: 'paralizado',
  });
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(saveCalls, 1);

  const partialSaved = orderDoc.items.find((item: any) => item.productCode === 'P-1');
  assert.equal(partialSaved.pendingReason, 'Faltante: 3 de 5 controlados');
  assert.equal(partialSaved.isPending, false);
  assert.equal(partialSaved.lineTotal, 270);

  const uncontrolledSaved = orderDoc.items.find((item: any) => item.productCode === 'P-2');
  assert.equal(uncontrolledSaved.pendingReason, PENDING_REASON_UNCONTROLLED);
  assert.equal(uncontrolledSaved.isPending, true);
  assert.equal(uncontrolledSaved.lineTotal, 0);

  assert.equal(orderDoc.status, 'paralizado');
});

test('PUT limpia el pendingReason cuando depósito vuelve a controlar la línea', async () => {
  seedOrder({
    status: 'paralizado',
    items: [
      makeItem({
        verifiedQuantity: 0,
        isPending: true,
        pendingReason: 'Sin stock en depósito',
        lineTotal: 0,
      }),
    ],
  });
  saveCalls = 0;
  notificationsCreated = [];

  const item = orderDoc.items[0];
  const response = await putOrder({
    items: [{ _id: item._id, verifiedQuantity: 3, isPending: false }],
    status: 'facturacion',
  });
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(orderDoc.items[0].pendingReason, undefined);
  assert.equal(orderDoc.items[0].lineTotal, 270);
  assert.equal(orderDoc.status, 'facturacion');
});

test('un ítem eliminado en depósito se conserva como pendiente con su motivo', async () => {
  const kept = makeItem();
  const removed = makeItem({
    productCode: 'P-2',
    productName: 'Producto Dos',
    requestedQuantity: 2,
  });
  seedOrder({ items: [kept, removed] });
  saveCalls = 0;
  notificationsCreated = [];

  const response = await putOrder({
    items: [{ _id: kept._id, verifiedQuantity: 3, isPending: false }],
    status: 'paralizado',
  });
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(orderDoc.items.length, 2, 'la línea eliminada no debe desaparecer');

  const preserved = orderDoc.items.find((item: any) => item.productCode === 'P-2');
  assert.ok(preserved, 'debe conservarse la línea eliminada');
  assert.equal(preserved.isPending, true);
  assert.equal(preserved.verifiedQuantity, 0);
  assert.equal(preserved.lineTotal, 0);
  assert.equal(preserved.pendingReason, PENDING_REASON_REMOVED);
  assert.equal(orderDoc.finalTotal, 270, 'la línea eliminada no suma al total');
});

test('una línea eliminada en depósito bloquea el pase a facturación', async () => {
  const kept = makeItem();
  const removed = makeItem({
    productCode: 'P-2',
    productName: 'Producto Dos',
    requestedQuantity: 2,
  });
  seedOrder({ items: [kept, removed] });
  saveCalls = 0;
  notificationsCreated = [];

  const response = await putOrder({
    items: [{ _id: kept._id, verifiedQuantity: 3, isPending: false }],
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
