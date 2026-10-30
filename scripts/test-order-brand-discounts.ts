/**
 * Prueba del POST /api/orders: los descuentos por marca del cliente deben
 * precomputarse en un Map (brandId -> %) antes del bucle de ítems, sin volver
 * a buscar en client.brandDiscounts por cada producto.
 *
 * No requiere base de datos ni servidor: se deja una conexión mongoose cacheada
 * falsa (global.mongoose) y se stubbean los statics de los modelos antes de
 * importar el route handler.
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

const brandA = new mongoose.Types.ObjectId();
const brandB = new mongoose.Types.ObjectId();
const productA = new mongoose.Types.ObjectId();
const productB = new mongoose.Types.ObjectId();

const oid = () => new mongoose.Types.ObjectId().toString();

let fakeClient: any = null;
let fakeProducts: any[] = [];

let POST: (request: Request) => Promise<Response>;

const postOrder = async (body: any) => {
  const response = await POST(
    authRequest(
      'http://localhost/api/orders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      'vendedor',
    ),
  );
  return { status: response.status, json: await response.json() };
};

const useClient = (client: any) => {
  fakeClient = { _id: oid(), name: 'Cliente Test', ...client };
};

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Client as any, 'findById', () => ({ select: () => fakeClient }));
  // El route proyecta los campos del catálogo y populea la marca para el snapshot.
  const productQuery = () => {
    const chain: any = {
      select: () => chain,
      populate: () => chain,
      lean: async () => fakeProducts,
    };
    return chain;
  };
  mock.method(Product as any, 'find', productQuery);
  mock.method(Order as any, 'create', async (doc: any) => ({
    _id: new mongoose.Types.ObjectId(),
    ...doc,
  }));
  mock.method(Notification as any, 'create', async (doc: any) => doc);

  POST = (await import('../app/api/orders/route')).POST;
});

after(() => mock.restoreAll());

test('aplica el descuento por marca precomputado (incluido el 0) sin find() dentro del bucle', async () => {
  const clientId = oid();
  const brandDiscounts: any = [
    { brandId: brandA, discountPercentage: 25 },
    { brandId: brandB, discountPercentage: 0 }, // marca con 0% pisa al descuento general (10%)
  ];
  // Si el route vuelve a hacer client.brandDiscounts.find(...) por ítem, este test falla.
  brandDiscounts.find = () => {
    throw new Error('client.brandDiscounts.find() no debe llamarse durante el bucle de ítems');
  };

  useClient({ _id: clientId, generalDiscount: 10, brandDiscounts });
  fakeProducts = [
    { _id: productA, price: 100, brandId: brandA },
    { _id: productB, price: 200, brandId: brandB },
  ];

  const { status, json } = await postOrder({
    clientId,
    createdBy: 'vendedor',
    invoiceType: 'A',
    paymentCondition: 'contado',
    items: [
      { productId: String(productA), requestedQuantity: 2 },
      { productId: String(productB), requestedQuantity: 1 },
    ],
  });

  assert.equal(status, 200);
  assert.equal(json.success, true);
  // Marca A: 200 - 25% = 150. Marca B: 200 con 0% (no cae al general).
  assert.deepEqual(
    json.order.items.map((item: any) => item.itemDiscount),
    [25, 0],
  );
  assert.deepEqual(
    json.order.items.map((item: any) => item.lineTotal),
    [150, 200],
  );
  assert.equal(json.order.subtotal, 400);
  assert.equal(json.order.totalDiscount, 50);
  assert.equal(json.order.finalTotal, 350);
});

test('el customDiscount del ítem pisa al de marca y, sin marca configurada, rige el general', async () => {
  useClient({
    _id: oid(),
    generalDiscount: 10,
    brandDiscounts: [{ brandId: brandA, discountPercentage: 25 }],
  });
  fakeProducts = [
    { _id: productA, price: 100, brandId: brandA },
    { _id: productB, price: 100, brandId: brandB },
  ];

  const { status, json } = await postOrder({
    clientId: oid(),
    createdBy: 'vendedor',
    invoiceType: 'B',
    paymentCondition: 'contado',
    items: [
      { productId: String(productA), requestedQuantity: 1, customDiscount: 50 },
      { productId: String(productB), requestedQuantity: 1 },
    ],
  });

  assert.equal(status, 200);
  assert.deepEqual(
    json.order.items.map((item: any) => item.itemDiscount),
    [50, 10],
  );
  assert.equal(json.order.totalDiscount, 60);
  assert.equal(json.order.finalTotal, 140);
});
