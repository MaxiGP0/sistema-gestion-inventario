/**
 * Pruebas de duplicación de pedidos:
 * - El servicio recalcula precio, snapshot y descuento vigentes (no copia los
 *   importes congelados del pedido original).
 * - Las líneas de productos inactivos o inexistentes se omiten y se informan;
 *   si no queda ninguna, responde 400.
 * - POST /api/orders/[id]/duplicate exige admin/vendedor y el vendedor sólo
 *   puede duplicar pedidos propios.
 * - Un reintento con la misma Idempotency-Key devuelve el pedido ya creado y no
 *   inserta un segundo borrador.
 *
 * No requiere base de datos: se usa una conexión mongoose falsa y stubs de los
 * modelos, igual que el resto de la suite.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import type { UserRole } from '../lib/authz';
import { Client } from '../models/Client';
import { Notification } from '../models/Notification';
import { Order } from '../models/Order';
import { Product } from '../models/Product';
import { DUPLICATE_NO_ITEMS_ERROR, duplicateOrderDraft } from '../lib/services/orders';
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId().toString();

const OWNER_ID = '0000000000000000000000a1';
const OTHER_ID = '0000000000000000000000b2';
const SESSION_USERNAME = 'test-vendedor';

const clientId = oid();
const brandId = oid();
const activeProductId = oid();
const inactiveProductId = oid();
const missingProductId = oid();

const client = {
  code: 'CLI-1',
  name: 'Cliente Demo',
  generalDiscount: 10,
  brandDiscounts: [{ brandId, discountPercentage: 25 }],
};

const products = [
  {
    _id: activeProductId,
    code: 'ACT',
    name: 'Producto Activo',
    price: 200,
    brandId: { _id: brandId, name: 'Marca Demo' },
    active: true,
  },
  {
    _id: inactiveProductId,
    code: 'INA',
    name: 'Producto Inactivo',
    price: 50,
    brandId: { _id: brandId, name: 'Marca Demo' },
    active: false,
  },
];

const sourceOrder: any = {
  _id: oid(),
  clientId,
  clientName: 'Cliente Demo',
  clientCode: 'CLI-1',
  status: 'entregado',
  items: [
    {
      _id: oid(),
      productId: activeProductId,
      productCode: 'OLD-ACT',
      productName: 'Precio viejo',
      unitPrice: 1,
      requestedQuantity: 3,
      verifiedQuantity: 3,
      isPending: false,
      itemDiscount: 90,
      lineTotal: 3,
    },
    {
      _id: oid(),
      productId: inactiveProductId,
      productCode: 'OLD-INA',
      productName: 'Producto Inactivo',
      unitPrice: 50,
      requestedQuantity: 2,
      verifiedQuantity: 2,
      isPending: false,
      itemDiscount: 0,
      lineTotal: 100,
    },
    {
      _id: oid(),
      productId: missingProductId,
      productCode: 'OLD-MISS',
      productName: 'Producto Eliminado',
      unitPrice: 80,
      requestedQuantity: 1,
      verifiedQuantity: 1,
      isPending: false,
      itemDiscount: 0,
      lineTotal: 80,
    },
  ],
  invoiceType: 'A',
  paymentCondition: 'cuenta_corriente',
  createdById: OWNER_ID,
  createdBy: SESSION_USERNAME,
};

let createdOrders: any[] = [];
const duplicateByKey = new Map<string, any>();

let POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Order as any, 'findById', (id: string) => ({
    select: () => ({
      lean: async () => (String(sourceOrder._id) === String(id) ? sourceOrder : null),
    }),
  }));

  mock.method(Order as any, 'findOne', (filter: any) => ({
    lean: async () => duplicateByKey.get(`${filter.createdById}:${filter.clientRequestId}`) ?? null,
  }));

  mock.method(Order as any, 'create', async (doc: any) => {
    const created = { _id: oid(), ...doc };
    createdOrders.push(created);
    if (doc.clientRequestId) {
      duplicateByKey.set(`${doc.createdById}:${doc.clientRequestId}`, created);
    }
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

  mock.method(Notification as any, 'create', async (doc: any) => ({
    _id: oid(),
    ...doc,
  }));

  ({ POST } = await import('../app/api/orders/[id]/duplicate/route'));
});

after(() => mock.restoreAll());

const duplicateRequest = (key?: string, role: UserRole = 'vendedor', userId = OWNER_ID) => {
  const headers: Record<string, string> = {};
  if (key) headers['Idempotency-Key'] = key;

  return POST(
    authRequest(
      `http://localhost/api/orders/${sourceOrder._id}/duplicate`,
      { method: 'POST', headers },
      role,
      userId,
    ),
    { params: Promise.resolve({ id: String(sourceOrder._id) }) },
  );
};

// ---------------------------------------------------------------------------
// Servicio puro
// ---------------------------------------------------------------------------

test('duplicateOrderDraft copia cantidades y recalcula precios/descuentos vigentes', () => {
  const result = duplicateOrderDraft({
    source: { ...sourceOrder, clientId: String(clientId) },
    client,
    products,
    createdBy: 'nuevo-vendedor',
    createdById: OTHER_ID,
    createdByRole: 'vendedor',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const { order, omittedItems } = result.value;

  assert.equal(order.status, 'borrador');
  assert.equal(order.clientId, String(clientId));
  assert.equal(order.clientName, 'Cliente Demo');
  assert.equal(order.invoiceType, 'A');
  assert.equal(order.paymentCondition, 'cuenta_corriente');
  assert.equal(order.createdBy, 'nuevo-vendedor');
  assert.equal(order.createdById, OTHER_ID);

  assert.equal(order.items.length, 1);
  const [item] = order.items;
  assert.equal(item.productId, activeProductId);
  assert.equal(item.requestedQuantity, 3, 'conserva la cantidad solicitada');
  assert.equal(item.unitPrice, 200, 'usa el precio actual, no el del pedido original');
  assert.equal(item.itemDiscount, 25, 'usa el descuento por marca vigente');
  assert.equal(item.lineTotal, 450);

  assert.equal(order.subtotal, 600);
  assert.equal(order.totalDiscount, 150);
  assert.equal(order.finalTotal, 450);

  assert.deepEqual(
    omittedItems.map((omitted) => ({
      productCode: omitted.productCode,
      requestedQuantity: omitted.requestedQuantity,
      reason: omitted.reason,
    })),
    [
      { productCode: 'INA', requestedQuantity: 2, reason: 'inactive' },
      { productCode: 'OLD-MISS', requestedQuantity: 1, reason: 'not_found' },
    ],
  );
});

test('duplicateOrderDraft falla con 400 si todos los productos están inactivos o faltan', () => {
  const result = duplicateOrderDraft({
    source: {
      ...sourceOrder,
      clientId: String(clientId),
      items: sourceOrder.items.slice(1),
    },
    client,
    products,
    createdBy: 'nuevo-vendedor',
    createdById: OTHER_ID,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.equal(result.message, DUPLICATE_NO_ITEMS_ERROR);
    assert.equal(
      (result.extras?.omittedItems as Array<{ reason: string }>).length,
      2,
      'el 400 también informa qué líneas se omitieron',
    );
  }
});

test('duplicateOrderDraft rechaza pedidos históricos sin datos comerciales', () => {
  const result = duplicateOrderDraft({
    source: {
      ...sourceOrder,
      clientId: String(clientId),
      invoiceType: undefined,
    },
    client,
    products,
    createdBy: 'nuevo-vendedor',
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 400);
});

// ---------------------------------------------------------------------------
// Ruta HTTP
// ---------------------------------------------------------------------------

test('POST duplicate rechaza a controlador y billing antes de tocar la base', async () => {
  for (const role of ['controlador', 'billing'] as const) {
    createdOrders = [];
    const response = await duplicateRequest(undefined, role, OWNER_ID);
    assert.equal(response.status, 403, role);
    assert.equal(createdOrders.length, 0, role);
  }
});

test('un vendedor no puede duplicar el pedido de otro usuario', async () => {
  createdOrders = [];
  const response = await duplicateRequest(undefined, 'vendedor', OTHER_ID);
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.match(payload.error, /autorizado/i);
  assert.equal(createdOrders.length, 0);
});

test('admin puede duplicar el pedido de otro y firma la copia con su sesión', async () => {
  createdOrders = [];
  const response = await duplicateRequest('admin-key', 'admin', OTHER_ID);
  const payload = await response.json();

  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.order.createdBy, 'test-admin');
  assert.equal(payload.order.createdById, OTHER_ID);
  assert.equal(payload.order.items.length, 1);
  assert.equal(payload.order.items[0].unitPrice, 200);
  assert.equal(createdOrders.length, 1);
});

test('la respuesta informa las líneas inactivas omitidas y los totales recalculados', async () => {
  createdOrders = [];
  duplicateByKey.clear();

  const response = await duplicateRequest('omitted-key');
  const payload = await response.json();

  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.omittedItems.length, 2);
  assert.deepEqual(
    payload.omittedItems.map((item: any) => item.reason),
    ['inactive', 'not_found'],
  );
  assert.equal(payload.order.items.length, 1);
  assert.equal(payload.order.items[0].requestedQuantity, 3);
  assert.equal(payload.order.items[0].unitPrice, 200);
  assert.equal(payload.order.items[0].itemDiscount, 25);
  assert.equal(payload.order.finalTotal, 450);
  assert.equal(createdOrders.length, 1);
});

test('reintentar con la misma Idempotency-Key no crea otro pedido', async () => {
  createdOrders = [];
  duplicateByKey.clear();
  const key = 'retry-key';

  const first = await duplicateRequest(key);
  const firstPayload = await first.json();
  assert.equal(first.status, 200, JSON.stringify(firstPayload));
  assert.equal(createdOrders.length, 1);

  const second = await duplicateRequest(key);
  const secondPayload = await second.json();

  assert.equal(second.status, 200, JSON.stringify(secondPayload));
  assert.equal(secondPayload.deduplicated, true);
  assert.equal(secondPayload.order._id, firstPayload.order._id);
  assert.equal(createdOrders.length, 1, 'el reintento no debe volver a insertar');
});
