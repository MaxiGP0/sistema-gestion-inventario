/**
 * Pruebas de los índices y la proyección del catálogo de productos.
 *
 * GET /api/products filtra por `brandId + active`, ordena por `name` y busca
 * por prefijo sobre `searchName`/`searchCode` (minúsculas, sin acentos). Las
 * marcas se resuelven por `searchName` en lugar de un regex `i` no anclado.
 * Los índices de prefijo permiten que el countDocuments no termine en COLLSCAN.
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa y se
 * stubbean los statics antes de importar el route handler.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { Brand } from '../models/Brand';
import { Product } from '../models/Product';
import { buildBrandSearchFilter, buildProductSearchFilter } from '../lib/search-query';
import { buildProductSearchFields, normalizeSearchText } from '../lib/search-normalize';
import { authRequest } from './test-auth-utils';

type IndexOptions = Record<string, unknown>;
type FindCapture = {
  query: Record<string, unknown>;
  select?: string;
  populate?: { path: string; select?: string };
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
};

const brandId = new mongoose.Types.ObjectId().toString();
const finds: FindCapture[] = [];
const brandFinds: Record<string, unknown>[] = [];
let brandMatches: Array<{ _id: mongoose.Types.ObjectId; name: string }> = [];

let GET: (request: Request) => Promise<Response>;

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Product as any, 'find', (query: Record<string, unknown>) => {
    const capture: FindCapture = { query };
    finds.push(capture);
    const chain: any = {
      select: (select: string) => {
        capture.select = select;
        return chain;
      },
      populate: (path: string, select?: string) => {
        capture.populate = { path, select };
        return chain;
      },
      sort: (sort: Record<string, 1 | -1>) => {
        capture.sort = sort;
        return chain;
      },
      skip: (skip: number) => {
        capture.skip = skip;
        return chain;
      },
      limit: (limit: number) => {
        capture.limit = limit;
        return chain;
      },
      lean: async () => [],
    };
    return chain;
  });
  mock.method(Product as any, 'countDocuments', async () => 0);
  mock.method(Brand as any, 'find', (query: Record<string, unknown>) => {
    brandFinds.push(query);
    return {
      select: () => ({ lean: async () => brandMatches }),
    };
  });

  ({ GET } = await import('../app/api/products/route'));
});

after(() => mock.restoreAll());

const reset = () => {
  finds.length = 0;
  brandFinds.length = 0;
  brandMatches = [];
};

test('normaliza nombre y código de producto (acentos y mayúsculas)', () => {
  assert.equal(normalizeSearchText('  GÓMEZ   Núñez  '), 'gomez nunez');
  assert.deepEqual(buildProductSearchFields({ name: 'DermaPlus GÓMEZ', code: 'Ñ-10' }), {
    searchName: 'dermaplus gomez',
    searchCode: 'n-10',
    searchTokens: ['n', '10', 'dermaplus', 'gomez'],
  });
  assert.deepEqual(
    buildProductSearchFields({
      name: 'Jabón Líquido 400ml',
      code: 'JAB-400',
      brandName: 'BioSalud',
    }),
    {
      searchName: 'jabon liquido 400ml',
      searchCode: 'jab-400',
      searchTokens: ['jab', '400', 'jabon', 'liquido', '400ml', 'biosalud'],
    },
  );
  assert.deepEqual(
    buildProductSearchFields({
      name: 'Jabón Líquido 400ml',
      code: 'JAB-400',
      brandId: { name: 'BioSalud' },
    }).searchTokens,
    ['jab', '400', 'jabon', 'liquido', '400ml', 'biosalud'],
    'un brandId poblado también aporta el nombre de la marca',
  );
});

test('buildBrandSearchFilter compara cada token contra el prefijo del nombre', () => {
  assert.deepEqual(buildBrandSearchFilter('biosalud 400'), {
    $or: [
      { searchName: /^biosalud/ },
      { searchName: /^400/ },
      { searchName: { $exists: false }, name: /biosalud/i },
      { searchName: { $exists: false }, name: /400/i },
    ],
  });
});

test('buildProductSearchFilter descuenta los tokens de la marca y exige el resto al producto', () => {
  const matchingBrandId = new mongoose.Types.ObjectId();
  const filter = buildProductSearchFilter('biosalud 400', [
    { _id: matchingBrandId, name: 'BioSalud' },
  ])!;
  const [brandBranch, indexed] = filter.$or as any[];

  assert.deepEqual(indexed, { searchTokens: { $all: [/^biosalud/, /^400/] } });
  assert.deepEqual(brandBranch, {
    $and: [
      { brandId: { $in: [matchingBrandId] } },
      {
        $or: [
          { searchTokens: { $all: [/^400/] } },
          {
            searchTokens: { $exists: false },
            $and: [
              {
                $or: [
                  { searchName: /^400/ },
                  { searchCode: /^400/ },
                  { searchName: { $exists: false }, name: /400/i },
                  { searchCode: { $exists: false }, code: /400/i },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  const brandOnly = buildProductSearchFilter('biosalud', [
    { _id: matchingBrandId, name: 'BioSalud' },
  ])!;
  assert.deepEqual((brandOnly.$or as any[])[0], { brandId: { $in: [matchingBrandId] } });
});

test('el schema declara el único de brandId+code, los compuestos de listado y los de prefijo', () => {
  const declared = Product.schema.indexes().map(([key, options]) => ({
    key: key as Record<string, unknown>,
    options: options as IndexOptions,
  }));

  assert.deepEqual(
    declared.map(({ key }) => key),
    [
      { brandId: 1, code: 1 },
      { brandId: 1, name: 1, active: 1 },
      { name: 1, active: 1 },
      { searchName: 1, active: 1 },
      { searchCode: 1, active: 1 },
      { searchTokens: 1, active: 1 },
      { updatedAt: 1, _id: 1 },
    ],
    'el catálogo debe tener índices para marca+activo, orden, búsqueda multikey y snapshot',
  );
  assert.equal(declared[0].options.unique, true, 'brandId+code debe seguir siendo único');
});

test('GET /api/products filtra marca+activo, ordena por name y proyecta el listado', async () => {
  reset();
  const response = await GET(
    authRequest(`http://localhost/api/products?brandId=${brandId}&page=3&limit=25`),
  );

  assert.equal(response.status, 200);
  assert.equal(finds.length, 1, 'GET debe consultar Product.find()');

  const [find] = finds;
  assert.equal(find.query.brandId, brandId);
  assert.deepEqual(
    find.query.active,
    { $ne: false },
    'las bajas lógicas quedan fuera del catálogo',
  );
  assert.equal(
    find.select,
    '_id brandId code name imageUrl price priceWithIva',
    'no debe traer createdAt/updatedAt/__v ni campos internos',
  );
  assert.deepEqual(find.populate, { path: 'brandId', select: 'name codePrefix' });
  assert.deepEqual(find.sort, { name: 1 }, 'el índice compuesto resuelve el orden por name');
  assert.equal(find.skip, 50);
  assert.equal(find.limit, 25);
});

test('GET /api/products sin marca usa el índice de name+active', async () => {
  reset();

  const response = await GET(authRequest('http://localhost/api/products'));

  assert.equal(response.status, 200);
  assert.equal(finds.length, 1);
  assert.equal(finds[0].query.brandId, undefined);
  assert.deepEqual(finds[0].query.active, { $ne: false });
  assert.deepEqual(finds[0].sort, { name: 1 });
});

test('GET /api/products?search= usa tokens normalizados en producto y marca', async () => {
  reset();

  const response = await GET(
    authRequest(`http://localhost/api/products?search=${encodeURIComponent('GÓMEZ')}`),
  );

  assert.equal(response.status, 200);
  assert.equal(brandFinds.length, 1, 'debe resolver las marcas por prefijo una sola vez');

  const brandOr = brandFinds[0].$or as any[];
  assert.deepEqual(brandOr[0], { searchName: /^gomez/ });
  assert.deepEqual(brandOr[1], {
    searchName: { $exists: false },
    name: /GÓMEZ/i,
  });

  const queryOr = finds[0].query.$or as any[];
  assert.equal(queryOr.length, 2, 'rama indexada de tokens + fallback histórico');
  const [indexed, historical] = queryOr;
  assert.deepEqual(indexed, { searchTokens: { $all: [/^gomez/] } });
  assert.deepEqual(historical.searchTokens, { $exists: false });
  const historicalOr = historical.$and[0].$or as any[];
  assert.deepEqual(historicalOr[0], { searchName: /^gomez/ });
  assert.deepEqual(historicalOr[1], { searchCode: /^gomez/ });
  assert.deepEqual(historicalOr[2], {
    searchName: { $exists: false },
    name: /GÓMEZ/i,
  });

  assert.deepEqual(finds[0].query.active, { $ne: false });
  assert.deepEqual(finds[0].sort, { name: 1 });
});

test('GET /api/products?search= exige todos los tokens aunque estén en cualquier posición', async () => {
  reset();

  const response = await GET(
    authRequest(`http://localhost/api/products?search=${encodeURIComponent('shampoo 400')}`),
  );

  assert.equal(response.status, 200);
  const queryOr = finds[0].query.$or as any[];
  const indexed = queryOr[0];

  assert.deepEqual(indexed.searchTokens.$all, [/^shampoo/, /^400/]);
  assert.deepEqual(finds[0].query.active, { $ne: false });
});

test('GET /api/products?search=biosalud 400 resuelve la marca por token y exige el resto', async () => {
  reset();
  const matchingBrandId = new mongoose.Types.ObjectId();
  brandMatches = [{ _id: matchingBrandId, name: 'BioSalud' }];

  const response = await GET(
    authRequest(`http://localhost/api/products?search=${encodeURIComponent('biosalud 400')}`),
  );

  assert.equal(response.status, 200);
  assert.equal(brandFinds.length, 1);
  assert.deepEqual((brandFinds[0].$or as any[]).slice(0, 2), [
    { searchName: /^biosalud/ },
    { searchName: /^400/ },
  ]);

  const queryOr = finds[0].query.$or as any[];
  assert.deepEqual(queryOr[0], {
    $and: [
      { brandId: { $in: [matchingBrandId] } },
      {
        $or: [
          { searchTokens: { $all: [/^400/] } },
          {
            searchTokens: { $exists: false },
            $and: [
              {
                $or: [
                  { searchName: /^400/ },
                  { searchCode: /^400/ },
                  { searchName: { $exists: false }, name: /400/i },
                  { searchCode: { $exists: false }, code: /400/i },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(queryOr[1], { searchTokens: { $all: [/^biosalud/, /^400/] } });
});
