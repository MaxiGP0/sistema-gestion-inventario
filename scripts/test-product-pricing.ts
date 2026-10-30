/**
 * Pruebas del cálculo y del ajuste masivo de precios por marca:
 * - Redondeo a 2 decimales de `price` y `priceWithIva`.
 * - Parseo y validación Zod del porcentaje (incluye "+10%" y "-5").
 * - POST /api/products/bulk-price: sólo admin, filtra productos activos por
 *   marca (o todo el catálogo) y persiste ambos precios con bulkWrite.
 *
 * No requiere base de datos: se inyecta una conexión mongoose falsa y se
 * stubbean Product.find/Product.bulkWrite antes de importar el route handler.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { Product } from '../models/Product';
import {
  calculateAdjustedPrices,
  formatAdjustmentPercentage,
  netPriceFromGross,
  parseAdjustmentPercentage,
  priceWithIvaFromNet,
  roundCurrency,
} from '../lib/product-pricing';
import { bulkPriceAdjustmentSchema } from '../lib/validations';
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId();

interface ProductDoc {
  _id: mongoose.Types.ObjectId;
  price: number;
  priceWithIva?: number;
}

let productDocs: ProductDoc[] = [];
let findQueries: Record<string, unknown>[] = [];
let bulkWriteCalls: any[][] = [];
let bulkWriteResult: { matchedCount: number; modifiedCount: number } | null = null;
let POST: (request: Request) => Promise<Response>;

const resetState = () => {
  productDocs = [];
  findQueries = [];
  bulkWriteCalls = [];
  bulkWriteResult = null;
};

const productQuery = () => {
  const chain: Record<string, any> = {
    select: () => chain,
    lean: async () => productDocs,
  };
  return chain;
};

const jsonRequest = (
  body: unknown,
  role: 'admin' | 'vendedor' | 'controlador' = 'admin',
): Request =>
  authRequest(
    'http://localhost/api/products/bulk-price',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    role,
  );

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Product as any, 'find', (query: Record<string, unknown>) => {
    findQueries.push(query);
    return productQuery();
  });
  mock.method(Product as any, 'bulkWrite', async (operations: any[]) => {
    bulkWriteCalls.push(operations);
    return (
      bulkWriteResult ?? {
        matchedCount: productDocs.length,
        modifiedCount: productDocs.length,
      }
    );
  });

  ({ POST } = await import('../app/api/products/bulk-price/route'));
});

after(() => mock.restoreAll());

beforeEach(resetState);

test('redondea precios con IVA y sin IVA a 2 decimales', () => {
  assert.equal(roundCurrency(1100.0000000000002), 1100);
  assert.equal(priceWithIvaFromNet(1000), 1210);
  assert.equal(netPriceFromGross(1210), 1000);
  assert.deepEqual(calculateAdjustedPrices({ price: 10.01, priceWithIva: 12.11 }, 10), {
    price: 11.01,
    priceWithIva: 13.32,
  });
  assert.deepEqual(calculateAdjustedPrices({ price: 1000, priceWithIva: 1210 }, -5), {
    price: 950,
    priceWithIva: 1149.5,
  });
  assert.deepEqual(calculateAdjustedPrices({ price: 100, priceWithIva: 121 }, -100), {
    price: 0,
    priceWithIva: 0,
  });
});

test('parsea porcentajes con signo, coma decimal y sufijo %', () => {
  assert.equal(parseAdjustmentPercentage('+10%'), 10);
  assert.equal(parseAdjustmentPercentage('-5'), -5);
  assert.equal(parseAdjustmentPercentage('7,5%'), 7.5);
  assert.equal(parseAdjustmentPercentage('0'), null);
  assert.equal(parseAdjustmentPercentage('abc'), null);
  assert.equal(parseAdjustmentPercentage('-101'), null);
  assert.equal(parseAdjustmentPercentage('1001'), null);
  assert.equal(formatAdjustmentPercentage(10), '+10%');
  assert.equal(formatAdjustmentPercentage(-5), '-5%');
});

test('el schema de ajuste acepta marca opcional y porcentaje con sufijo', () => {
  assert.deepEqual(bulkPriceAdjustmentSchema.parse({ percentage: '+10%' }), {
    percentage: 10,
  });

  const allBrands = bulkPriceAdjustmentSchema.parse({ brandId: '', percentage: '-5' });
  assert.equal(allBrands.brandId, undefined);
  assert.equal(allBrands.percentage, -5);

  for (const body of [
    { percentage: 0 },
    { percentage: 'abc' },
    { percentage: -101 },
    { percentage: 10, brandId: 'no-es-un-object-id' },
  ]) {
    assert.equal(
      bulkPriceAdjustmentSchema.safeParse(body).success,
      false,
      `debe rechazar ${JSON.stringify(body)}`,
    );
  }
});

test('admin ajusta sólo los productos activos de la marca y redondea ambos precios', async () => {
  const brandId = oid().toString();
  productDocs = [
    { _id: oid(), price: 1000, priceWithIva: 1210 },
    { _id: oid(), price: 500, priceWithIva: 605 },
  ];

  const response = await POST(jsonRequest({ brandId, percentage: '+10%' }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.updated, 2);
  assert.equal(payload.matched, 2);
  assert.equal(payload.brandId, brandId);
  assert.equal(payload.percentage, 10);

  assert.deepEqual(findQueries, [{ active: { $ne: false }, brandId }]);
  assert.equal(bulkWriteCalls.length, 1);
  assert.equal(bulkWriteCalls[0].length, 2);

  const updates = bulkWriteCalls[0].map((operation: any) => operation.updateOne.update.$set);
  assert.deepEqual(updates, [
    { price: 1100, priceWithIva: 1331 },
    { price: 550, priceWithIva: 665.5 },
  ]);
});

test('sin marca ajusta todo el catálogo activo', async () => {
  productDocs = [{ _id: oid(), price: 200, priceWithIva: 242 }];

  const response = await POST(jsonRequest({ percentage: -5 }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.brandId, null);
  assert.equal(payload.updated, 1);
  assert.deepEqual(findQueries, [{ active: { $ne: false } }]);
  assert.deepEqual(bulkWriteCalls[0][0].updateOne.update.$set, {
    price: 190,
    priceWithIva: 229.9,
  });
});

test('sin productos activos responde 0 y no ejecuta bulkWrite', async () => {
  const response = await POST(jsonRequest({ brandId: oid().toString(), percentage: 10 }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.matched, 0);
  assert.equal(payload.updated, 0);
  assert.equal(bulkWriteCalls.length, 0);
});

test('un vendedor no puede ajustar precios (403) y no consulta la base', async () => {
  const response = await POST(
    jsonRequest({ brandId: oid().toString(), percentage: 10 }, 'vendedor'),
  );

  assert.equal(response.status, 403);
  assert.equal(findQueries.length, 0);
  assert.equal(bulkWriteCalls.length, 0);
});

test('un controlador tampoco puede ajustar precios (403)', async () => {
  const response = await POST(jsonRequest({ percentage: 10 }, 'controlador'));

  assert.equal(response.status, 403);
  assert.equal(findQueries.length, 0);
});

test('un porcentaje inválido responde 400 antes de tocar la base', async () => {
  const response = await POST(jsonRequest({ percentage: 0 }));

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /porcentaje/i);
  assert.equal(findQueries.length, 0);
  assert.equal(bulkWriteCalls.length, 0);
});
