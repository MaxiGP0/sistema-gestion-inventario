/**
 * Pruebas de los snapshots del pedido:
 * - POST /api/orders guarda clientName/clientCode y productCode/productName/brandName.
 * - PUT /api/orders/[id] conserva el snapshot de los ítems existentes, completa
 *   el de los ítems nuevos desde el catálogo y hace backfill del cliente en
 *   pedidos históricos.
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa y se
 * stubbean los statics de los modelos antes de importar los route handlers.
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
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId().toString();
const brandId = new mongoose.Types.ObjectId();

let fakeClient: any;
let fakeProducts: any[] = [];
let orderDoc: any = null;
let saveCalls = 0;

let POST: (request: Request) => Promise<Response>;
let PUT: (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

/** Query falsa de Product: soporta select/populate/lean como Mongoose. */
const fakeProductQuery = () => {
  const chain: any = {
    select: () => chain,
    populate: () => chain,
    lean: async () => fakeProducts,
  };
  return chain;
};

const postOrder = async (body: unknown, userId?: string) => {
  const response = await POST(
    authRequest(
      'http://localhost/api/orders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      'vendedor',
      userId,
    ),
  );
  return { status: response.status, json: await response.json() };
};

const putOrder = async (body: object) => {
  const response = await PUT(
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
  return { status: response.status, json: await response.json() };
};

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  fakeClient = {
    _id: oid(),
    code: 'CLI-1',
    name: 'Cliente Demo',
    generalDiscount: 0,
    brandDiscounts: [],
  };

  mock.method(Client as any, 'findById', () => ({ select: () => fakeClient }));
  mock.method(Product as any, 'find', fakeProductQuery);
  mock.method(Order as any, 'create', async (doc: any) => ({ _id: oid(), ...doc }));
  mock.method(Order as any, 'findById', () => ({ populate: async () => orderDoc }));
  mock.method(Notification as any, 'create', async (doc: any) => doc);

  POST = (await import('../app/api/orders/route')).POST;
  ({ PUT } = await import('../app/api/orders/[id]/route'));
});

after(() => mock.restoreAll());

test('POST /api/orders guarda snapshots del cliente y de cada línea', async () => {
  const productId = oid();
  fakeProducts = [
    {
      _id: productId,
      code: 'P-1',
      name: 'Producto Uno',
      price: 100,
      brandId: { _id: brandId, name: 'Marca Uno' },
    },
  ];

  const { status, json } = await postOrder({
    clientId: fakeClient._id,
    createdBy: 'vendedor',
    invoiceType: 'A',
    paymentCondition: 'contado',
    items: [{ productId, requestedQuantity: 2 }],
  });

  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.order.invoiceType, 'A');
  assert.equal(json.order.clientName, 'Cliente Demo');
  assert.equal(json.order.clientCode, 'CLI-1');
  assert.equal(json.order.items[0].productCode, 'P-1');
  assert.equal(json.order.items[0].productName, 'Producto Uno');
  assert.equal(json.order.items[0].brandName, 'Marca Uno');
});

test('POST /api/orders firma el alta con la sesión e ignora createdBy del body', async () => {
  const productId = oid();
  const sessionUserId = '0000000000000000000000aa';
  fakeProducts = [
    {
      _id: productId,
      code: 'P-2',
      name: 'Producto Dos',
      price: 50,
      brandId: null,
    },
  ];

  const { status, json } = await postOrder(
    {
      clientId: fakeClient._id,
      // Intento de suplantación: la API debe descartarlo.
      createdBy: 'Otro Vendedor',
      invoiceType: 'A',
      paymentCondition: 'contado',
      comment: 'Comentario del alta',
      items: [{ productId, requestedQuantity: 1 }],
    },
    sessionUserId,
  );

  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.order.createdBy, 'test-vendedor');
  assert.equal(json.order.createdById, sessionUserId);
  assert.equal(json.order.comments[0].author, 'test-vendedor');
  assert.equal(json.order.comments[0].role, 'vendedor');
});

test('PUT /api/orders/[id] completa snapshots del alta y conserva los existentes', async () => {
  const existingItemId = oid();
  const existingProductId = oid();
  const newProductId = oid();

  orderDoc = {
    _id: oid(),
    status: 'borrador',
    // Pedido histórico: sin clientName/clientCode.
    clientId: {
      _id: fakeClient._id,
      code: 'CLI-1',
      name: 'Cliente Demo',
      generalDiscount: 0,
      brandDiscounts: [],
    },
    items: [
      {
        _id: existingItemId,
        productId: existingProductId,
        productCode: 'OLD-1',
        productName: 'Producto Existente',
        brandName: 'Marca Existente',
        unitPrice: 50,
        requestedQuantity: 1,
        verifiedQuantity: 0,
        isPending: false,
        itemDiscount: 0,
        lineTotal: 0,
      },
    ],
    subtotal: 50,
    totalDiscount: 0,
    finalTotal: 50,
    comments: [],
    version: 0,
    save: async () => {
      saveCalls += 1;
      orderDoc.version = (orderDoc.version ?? 0) + 1;
    },
  };
  saveCalls = 0;

  fakeProducts = [
    {
      _id: newProductId,
      code: 'NEW-1',
      name: 'Producto Nuevo',
      price: 100,
      brandId: { _id: brandId, name: 'Marca Nueva' },
    },
  ];

  const { status, json } = await putOrder({
    items: [
      { _id: existingItemId, verifiedQuantity: 1 },
      { productId: newProductId, requestedQuantity: 2, verifiedQuantity: 2 },
    ],
  });

  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(saveCalls, 1);
  assert.equal(orderDoc.clientName, 'Cliente Demo');
  assert.equal(orderDoc.clientCode, 'CLI-1');

  const [existing, added] = orderDoc.items;

  // El ítem existente mantiene su snapshot original.
  assert.equal(existing.productCode, 'OLD-1');
  assert.equal(existing.productName, 'Producto Existente');
  assert.equal(existing.brandName, 'Marca Existente');
  assert.equal(existing.unitPrice, 50);

  // El ítem nuevo toma el snapshot del catálogo.
  assert.deepEqual(
    {
      productCode: added.productCode,
      productName: added.productName,
      brandName: added.brandName,
      unitPrice: added.unitPrice,
      requestedQuantity: added.requestedQuantity,
      verifiedQuantity: added.verifiedQuantity,
      lineTotal: added.lineTotal,
    },
    {
      productCode: 'NEW-1',
      productName: 'Producto Nuevo',
      brandName: 'Marca Nueva',
      unitPrice: 100,
      requestedQuantity: 2,
      verifiedQuantity: 2,
      lineTotal: 200,
    },
  );
});
