/**
 * Pruebas de PUT /api/orders/[id] para ítems agregados desde depósito:
 * - El schema no descarta `requestedQuantity` ni `customDiscount`.
 * - La cantidad pedida del ítem nuevo se persiste (aunque difiera de la
 *   verificada y deje la línea pendiente).
 * - Si el ítem no trae descuento propio, se aplica el del cliente para la
 *   marca o, si no hay, el general. Un `customDiscount: 0` propio pisa al del
 *   cliente.
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa y se
 * stubbean los statics de Order/Product antes de importar el handler.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { Notification } from '../models/Notification';
import { Order } from '../models/Order';
import { Product } from '../models/Product';
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId().toString();

const brandA = new mongoose.Types.ObjectId();
const brandB = new mongoose.Types.ObjectId();
const productA = new mongoose.Types.ObjectId();
const productB = new mongoose.Types.ObjectId();
const productC = new mongoose.Types.ObjectId();

let orderDoc: any;
let products: any[] = [];
let saveCalls = 0;

let PUT: (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const seedOrder = ({ status = 'borrador', items = [] as any[] } = {}) => {
  orderDoc = {
    _id: oid(),
    status,
    items,
    subtotal: 0,
    totalDiscount: 0,
    finalTotal: 0,
    clientId: {
      code: 'C1',
      name: 'Cliente Test',
      generalDiscount: 10,
      // brandA tiene descuento propio; brandB cae al general.
      brandDiscounts: [{ brandId: brandA, discountPercentage: 25 }],
    },
    version: 0,
    save: async () => {
      saveCalls += 1;
      // Mongoose incrementa el versionKey al guardar.
      orderDoc.version += 1;
    },
  };
};

const putItems = (items: any[], status = 'paralizado') =>
  PUT(
    authRequest(
      `http://localhost/api/orders/${orderDoc._id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, status, version: orderDoc.version }),
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
  // El route consulta el catálogo para precio/descuento de los ítems nuevos.
  mock.method(Product as any, 'find', () => ({
    select: () => ({
      populate: () => ({ lean: async () => products }),
    }),
  }));

  // El picking con faltantes ahora emite una alerta privada al vendedor.
  mock.method(Notification as any, 'create', async (doc: any) => ({ _id: oid(), ...doc }));

  ({ PUT } = await import('../app/api/orders/[id]/route'));
});

after(() => mock.restoreAll());

test('persiste requestedQuantity y customDiscount del ítem nuevo y conserva el existente', async () => {
  const existingId = oid();
  const existingProductId = oid();
  seedOrder({
    items: [
      {
        _id: existingId,
        productId: existingProductId,
        unitPrice: 50,
        requestedQuantity: 2,
        verifiedQuantity: 2,
        isPending: false,
        itemDiscount: 5,
        lineTotal: 95,
      },
    ],
  });
  products = [
    {
      _id: productA,
      code: 'A',
      name: 'Producto A',
      price: 100,
      brandId: { _id: brandA, name: 'Marca A' },
    },
  ];
  saveCalls = 0;

  const response = await putItems([
    {
      _id: existingId,
      productId: existingProductId,
      requestedQuantity: 2,
      verifiedQuantity: 2,
      isPending: false,
    },
    // El descuento propio (30) debe pisar al de la marca (25).
    { productId: String(productA), requestedQuantity: 4, verifiedQuantity: 2, customDiscount: 30 },
  ]);
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(saveCalls, 1);

  const [existing, added] = payload.order.items;
  assert.equal(existing.requestedQuantity, 2);
  assert.equal(existing.unitPrice, 50);
  assert.equal(existing.itemDiscount, 5, 'el ítem existente conserva su descuento');

  assert.equal(added.requestedQuantity, 4, 'se persiste la cantidad pedida que envía depósito');
  assert.equal(added.verifiedQuantity, 2);
  assert.equal(added.customDiscount, undefined, 'customDiscount no es un campo del modelo');
  assert.equal(added.itemDiscount, 30, 'el descuento propio del ítem pisa al del cliente');
  assert.equal(added.unitPrice, 100, 'el ítem nuevo toma el precio del catálogo');
  // 100 x 2 verificado, 30% de descuento.
  assert.equal(added.lineTotal, 140);

  assert.equal(payload.order.subtotal, 300);
  assert.equal(payload.order.totalDiscount, 65);
  assert.equal(payload.order.finalTotal, 235);
});

test('sin descuento propio aplica el de la marca o el general, y respeta customDiscount 0', async () => {
  seedOrder();
  products = [
    {
      _id: productA,
      code: 'A',
      name: 'Producto A',
      price: 100,
      brandId: { _id: brandA, name: 'Marca A' },
    },
    {
      _id: productB,
      code: 'B',
      name: 'Producto B',
      price: 100,
      brandId: { _id: brandB, name: 'Marca B' },
    },
    // brandB no tiene descuento configurado: rige el general (10%).
    {
      _id: productC,
      code: 'C',
      name: 'Producto C',
      price: 100,
      brandId: { _id: brandA, name: 'Marca A' },
    },
  ];
  saveCalls = 0;

  const response = await putItems([
    { productId: String(productA), requestedQuantity: 1, verifiedQuantity: 1 },
    { productId: String(productB), requestedQuantity: 1, verifiedQuantity: 1 },
    // 0 es un descuento propio válido: no debe caer al de la marca (25%).
    { productId: String(productC), requestedQuantity: 1, verifiedQuantity: 1, customDiscount: 0 },
  ]);
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(saveCalls, 1);

  assert.deepEqual(
    payload.order.items.map((item: any) => item.itemDiscount),
    [25, 10, 0],
    'marca > general > descuento propio 0',
  );
  assert.deepEqual(
    payload.order.items.map((item: any) => item.requestedQuantity),
    [1, 1, 1],
  );
  assert.equal(payload.order.subtotal, 300);
  assert.equal(payload.order.totalDiscount, 35);
  assert.equal(payload.order.finalTotal, 265);
});

test('un ítem nuevo sin cantidad pedida no queda en 0: se asume la verificada', async () => {
  seedOrder();
  products = [
    {
      _id: productA,
      code: 'A',
      name: 'Producto A',
      price: 100,
      brandId: { _id: brandA, name: 'Marca A' },
    },
  ];

  const response = await putItems([{ productId: String(productA), verifiedQuantity: 3 }]);
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.order.items[0].requestedQuantity, 3);
  assert.equal(payload.order.items[0].itemDiscount, 25);
  assert.equal(payload.order.items[0].lineTotal, 225);
});
