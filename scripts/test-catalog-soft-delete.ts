/**
 * Pruebas de baja lógica de productos y protección de marcas referenciadas:
 * - DELETE /api/products/[id] desactiva (active: false), no borra.
 * - GET /api/products oculta los inactivos del catálogo, pero los sigue
 *   resolviendo cuando se piden explícitamente por ids (restauración de
 *   borradores/pedidos históricos).
 * - POST /api/products reactiva el producto si se vuelve a dar de alta.
 * - DELETE /api/brands/[id] bloquea si hay productos activos o clientes con
 *   descuentos de la marca, pero permite la baja si sus productos quedaron
 *   inactivos.
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa y se
 * stubbean los statics de Product/Brand/Client antes de importar los handlers.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { Brand } from '../models/Brand';
import { Client } from '../models/Client';
import { Product } from '../models/Product';
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId();

type RouteHandler = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

let productDelete: RouteHandler;
let productsGet: (request: Request) => Promise<Response>;
let productsPost: (request: Request) => Promise<Response>;
let brandDelete: RouteHandler;

let productExists = true;
let productDeleteCalls: { id: string; update: Record<string, unknown> }[] = [];
let hardDeleteCalls = 0;
let catalogQueries: Record<string, unknown>[] = [];
let productUpsert: any = null;
let activeProductCount = 0;
let productCountQueries: Record<string, unknown>[] = [];
let clientDiscountCount = 0;
let clientDiscountQueries: Record<string, unknown>[] = [];
let brandDeleteCalls = 0;

/** Cadena fluida mínima para las queries de Mongoose usadas por el listado. */
const productQuery = () => {
  const chain: Record<string, any> = {
    select: () => chain,
    populate: () => chain,
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    lean: async () => [],
  };
  return chain;
};

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Product as any, 'findByIdAndDelete', async () => {
    hardDeleteCalls += 1;
    return null;
  });
  mock.method(
    Product as any,
    'findByIdAndUpdate',
    async (id: string, update: Record<string, unknown>) => {
      productDeleteCalls.push({ id, update });
      return productExists ? { _id: id, ...update } : null;
    },
  );
  mock.method(Product as any, 'find', (query: Record<string, unknown>) => {
    catalogQueries.push(query);
    return productQuery();
  });
  mock.method(Product as any, 'countDocuments', async (query: Record<string, unknown>) => {
    productCountQueries.push(query);
    return query.active ? activeProductCount : 0;
  });
  mock.method(
    Product as any,
    'findOneAndUpdate',
    async (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => {
      productUpsert = { filter, update, options };
      return { _id: oid(), ...update };
    },
  );

  mock.method(Brand as any, 'findById', async (id: string) => ({ _id: id, name: 'Marca Test' }));
  mock.method(Brand as any, 'findByIdAndDelete', async (id: string) => {
    brandDeleteCalls += 1;
    return { _id: id, name: 'Marca Test' };
  });

  mock.method(Client as any, 'countDocuments', async (query: Record<string, unknown>) => {
    clientDiscountQueries.push(query);
    return clientDiscountCount;
  });

  ({ DELETE: productDelete } = await import('../app/api/products/[id]/route'));
  ({ GET: productsGet, POST: productsPost } = await import('../app/api/products/route'));
  ({ DELETE: brandDelete } = await import('../app/api/brands/[id]/route'));
});

after(() => mock.restoreAll());

test('DELETE /api/products/[id] desactiva el producto en vez de borrarlo', async () => {
  productExists = true;
  productDeleteCalls = [];
  hardDeleteCalls = 0;
  const id = oid().toString();

  const response = await productDelete(
    authRequest(`http://localhost/api/products/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(hardDeleteCalls, 0, 'no debe llamar a findByIdAndDelete');
  assert.deepEqual(productDeleteCalls, [{ id, update: { active: false } }]);
});

test('DELETE /api/products/[id] inexistente responde 404 y tampoco borra', async () => {
  productExists = false;
  productDeleteCalls = [];
  hardDeleteCalls = 0;
  const id = oid().toString();

  const response = await productDelete(
    authRequest(`http://localhost/api/products/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) },
  );

  assert.equal(response.status, 404);
  assert.equal(hardDeleteCalls, 0);
  assert.deepEqual(productDeleteCalls, [{ id, update: { active: false } }]);
});

test('GET /api/products oculta los productos dados de baja del catálogo', async () => {
  catalogQueries = [];

  const response = await productsGet(authRequest('http://localhost/api/products'));

  assert.equal(response.status, 200);
  assert.equal(catalogQueries.length, 1);
  assert.deepEqual(catalogQueries[0].active, { $ne: false });
  assert.equal(catalogQueries[0]._id, undefined);
});

test('GET /api/products?ids=... sigue resolviendo productos dados de baja', async () => {
  catalogQueries = [];
  const firstId = oid().toString();
  const secondId = oid().toString();

  const response = await productsGet(
    authRequest(`http://localhost/api/products?ids=${firstId},${secondId}`),
  );

  assert.equal(response.status, 200);
  assert.equal(catalogQueries.length, 1);
  assert.equal(
    catalogQueries[0].active,
    undefined,
    'la restauración por ids no debe filtrar active',
  );
  assert.deepEqual((catalogQueries[0]._id as { $in: string[] }).$in.map(String), [
    firstId,
    secondId,
  ]);
});

test('POST /api/products reactiva un producto existente dado de baja', async () => {
  productUpsert = null;
  const brandId = oid().toString();

  const response = await productsPost(
    authRequest('http://localhost/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandId, code: 'P1', name: 'Producto Uno', price: 10 }),
    }),
  );

  assert.equal(response.status, 200);
  assert.ok(productUpsert, 'debe llamar a findOneAndUpdate');
  assert.deepEqual(productUpsert!.filter, { brandId, code: 'P1' });
  assert.equal(productUpsert!.update.active, true);
  assert.equal(productUpsert!.options.upsert, true);
});

test('DELETE /api/brands/[id] bloquea si clientes usan la marca en sus descuentos', async () => {
  activeProductCount = 0;
  clientDiscountCount = 2;
  productCountQueries = [];
  clientDiscountQueries = [];
  brandDeleteCalls = 0;
  const id = oid().toString();

  const response = await brandDelete(
    authRequest(`http://localhost/api/brands/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) },
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.match(payload.error, /2 cliente\(s\)/);
  assert.deepEqual(productCountQueries, [{ brandId: id, active: { $ne: false } }]);
  assert.deepEqual(clientDiscountQueries, [{ 'brandDiscounts.brandId': id }]);
  assert.equal(brandDeleteCalls, 0, 'no debe borrar la marca referenciada');
});

test('DELETE /api/brands/[id] permite la baja cuando sus productos quedaron inactivos', async () => {
  clientDiscountCount = 0;
  productCountQueries = [];
  brandDeleteCalls = 0;
  const id = oid().toString();

  // Mientras quede un producto activo, la marca no se puede eliminar.
  activeProductCount = 2;
  const blockedResponse = await brandDelete(
    authRequest(`http://localhost/api/brands/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) },
  );
  const blockedPayload = await blockedResponse.json();

  assert.equal(blockedResponse.status, 400);
  assert.match(blockedPayload.error, /2 productos asociados/);
  assert.equal(brandDeleteCalls, 0, 'no debe borrar la marca con productos activos');

  // DELETE /api/products/[id] deja los productos en active: false: ya no
  // bloquean la baja de la marca.
  activeProductCount = 0;
  const allowedResponse = await brandDelete(
    authRequest(`http://localhost/api/brands/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) },
  );
  const allowedPayload = await allowedResponse.json();

  assert.equal(allowedResponse.status, 200);
  assert.equal(allowedPayload.success, true);
  assert.equal(brandDeleteCalls, 1);
  assert.deepEqual(productCountQueries, [
    { brandId: id, active: { $ne: false } },
    { brandId: id, active: { $ne: false } },
  ]);
});
