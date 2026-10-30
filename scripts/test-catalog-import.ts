/**
 * Pruebas de POST /api/catalog/import: el upsert masivo por bulkWrite debe
 * llegar al driver con los datos parseados del Excel (productos y clientes),
 * y el modo preview debe validar sin escribir nada.
 *
 * Regresiones cubiertas:
 * - Productos: el default de priceWithIva leía `this.price`, pero
 *   setDefaultsOnInsert lo evalúa con this = null durante los upserts de
 *   bulkWrite; el cast lanzaba TypeError y la importación respondía 400
 *   ("No se pudo importar ningún registro") sin escribir nada.
 * - Clientes: el encabezado DescuentoGeneral normaliza a "descuentogeneral"
 *   y no coincidía con ninguna clave: el descuento se guardaba en 0 en
 *   silencio.
 * - Marcas: "Bagó" y "BAGO" deben resolver a la misma marca; el preview no
 *   debe crear marcas ni ejecutar bulkWrite.
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa,
 * se stubbean Brand.find/insertMany y el bulkWrite del driver, y el Excel se
 * genera en memoria con exceljs.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';

import { Brand } from '../models/Brand';
import { Client } from '../models/Client';
import { Product } from '../models/Product';
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId();

type TestBrand = { _id: mongoose.Types.ObjectId; name: string };

interface TestProduct {
  _id: mongoose.Types.ObjectId;
  brandId: mongoose.Types.ObjectId;
  code: string;
  name: string;
  price: number;
  priceWithIva: number;
  imageUrl: string;
  active: boolean;
}

let brands: TestBrand[] = [];
let existingProducts: TestProduct[] = [];
let brandInsertCalls: string[][] = [];
let bulkWriteOps: any[] = [];
let clientBulkWriteOps: any[] = [];
let POST: (request: Request) => Promise<Response>;

const setBrands = (names: string[]): TestBrand[] => {
  brands = names.map((name) => ({ _id: oid(), name }));
  return brands;
};

const brandIdOf = (name: string): mongoose.Types.ObjectId => {
  const brand = brands.find((candidate) => candidate.name === name);
  assert.ok(brand, `la marca de prueba ${name} debería existir`);
  return brand._id;
};

interface SeedProductInput {
  brandName: string;
  code: string;
  name: string;
  price: number;
  priceWithIva?: number;
  imageUrl?: string;
  active?: boolean;
}

/** Producto ya existente que la consulta acotada del route debe encontrar. */
const seedProduct = (input: SeedProductInput): TestProduct => {
  const product: TestProduct = {
    _id: oid(),
    brandId: brandIdOf(input.brandName),
    code: input.code,
    name: input.name,
    price: input.price,
    priceWithIva:
      input.priceWithIva !== undefined
        ? input.priceWithIva
        : Number((input.price * 1.21).toFixed(2)),
    imageUrl: input.imageUrl ?? '',
    active: input.active ?? true,
  };
  existingProducts.push(product);
  return product;
};

const productExists = (filter: { brandId: unknown; code: unknown }): boolean =>
  existingProducts.some(
    (product) => String(product.brandId) === String(filter.brandId) && product.code === filter.code,
  );

/** Simula la proyección `{ brandId, code }` que usa el route. */
const lazyLean = (result: TestProduct[]) => ({
  lean: async () => result.map(({ _id, brandId, code }) => ({ _id, brandId, code })),
});

interface ImportOptions {
  /** Envía el modo preview por query string (?dryRun=1). */
  dryRun?: boolean;
  /** Envía el modo preview como campo del FormData (equivalente al checkbox). */
  dryRunInForm?: boolean;
  /** `both` (default), `name`, `price` o un valor inválido para probar el schema. */
  updateMode?: string;
}

/** Genera el archivo en memoria y dispara el route handler como lo haría el cliente. */
const importPayload = async (
  payload: BlobPart,
  filename: string,
  type: 'products' | 'clients',
  options: ImportOptions = {},
) => {
  const form = new FormData();
  form.append('file', new File([payload], filename));
  form.append('type', type);
  if (options.dryRunInForm) form.append('dryRun', 'true');
  if (options.updateMode !== undefined) form.append('updateMode', options.updateMode);

  const url = options.dryRun
    ? 'http://localhost/api/catalog/import?dryRun=1'
    : 'http://localhost/api/catalog/import';

  return POST(authRequest(url, { method: 'POST', body: form }));
};

const importFile = async (
  rows: Record<string, unknown>[],
  type: 'products' | 'clients',
  options: ImportOptions = {},
) => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Hoja1');
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  worksheet.addRow(headers);
  for (const row of rows) {
    worksheet.addRow(headers.map((header) => (row[header] ?? null) as ExcelJS.CellValue));
  }
  const buffer = await workbook.xlsx.writeBuffer();

  return importPayload(buffer, `${type}.xlsx`, type, options);
};

const importProducts = (rows: Record<string, unknown>[], options: ImportOptions = {}) =>
  importFile(rows, 'products', options);
const importClients = (rows: Record<string, unknown>[], options: ImportOptions = {}) =>
  importFile(rows, 'clients', options);

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Brand as any, 'find', (filter?: any) => {
    const requested = filter?.name?.$in;
    const result = Array.isArray(requested)
      ? brands.filter((brand) => requested.includes(brand.name))
      : brands;
    return { lean: async () => result };
  });
  mock.method(Brand as any, 'insertMany', async (docs: { name: string }[]) => {
    const names = docs.map((doc) => String(doc.name));
    brandInsertCalls.push(names);

    const created = names.map((name) => {
      const brand = { _id: oid(), name };
      brands.push(brand);
      return brand;
    });
    return created;
  });

  // El route consulta solo las claves marca + código del archivo. El mock
  // devuelve únicamente los productos sembrados por cada test.
  mock.method(Product as any, 'find', (filter?: any) => {
    const conditions = filter?.$or;
    const result = Array.isArray(conditions)
      ? existingProducts.filter((product) =>
          conditions.some(
            (condition: any) =>
              String(condition.brandId) === String(product.brandId) &&
              condition.code === product.code,
          ),
        )
      : existingProducts;

    return lazyLean(result);
  });

  mock.method((Product as any).$__collection, 'bulkWrite', async (ops: any[]) => {
    bulkWriteOps = ops;
    const matchedCount = ops.filter((op) => productExists(op.updateOne.filter)).length;
    return {
      ok: 1,
      acknowledged: true,
      insertedCount: 0,
      matchedCount,
      modifiedCount: matchedCount,
      deletedCount: 0,
      upsertedCount: ops.length - matchedCount,
      insertedIds: {},
      upsertedIds: {},
    };
  });

  mock.method((Client as any).$__collection, 'bulkWrite', async (ops: any[]) => {
    clientBulkWriteOps = ops;
    return {
      ok: 1,
      acknowledged: true,
      insertedCount: 0,
      matchedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      upsertedCount: ops.length,
      insertedIds: {},
      upsertedIds: {},
    };
  });

  ({ POST } = await import('../app/api/catalog/import/route'));
});

beforeEach(() => {
  setBrands(['General']);
  existingProducts = [];
  brandInsertCalls = [];
  bulkWriteOps = [];
  clientBulkWriteOps = [];
});

after(() => mock.restoreAll());

test('el import de productos upsertea por bulkWrite con los precios del Excel', async () => {
  const response = await importProducts([
    { Marca: 'General', Codigo: 'P1', Nombre: 'Producto Uno', 'Precio S/IVA': 10 },
    {
      Marca: 'General',
      Codigo: 'P2',
      Nombre: 'Producto Dos',
      'Precio C/IVA': 24.2,
      Imagen: 'http://img/2.png',
    },
  ]);
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.success, true);
  assert.equal(payload.count, 2);

  assert.equal(bulkWriteOps.length, 2, 'cada fila válida debe llegar al driver');
  for (const op of bulkWriteOps) {
    assert.ok(op.updateOne, 'cada operación debe ser un updateOne');
    assert.equal(op.updateOne.upsert, true);
  }

  const [firstUpdate, secondUpdate] = bulkWriteOps.map((op) => op.updateOne.update);
  const first = firstUpdate.$set;
  const second = secondUpdate.$set;

  assert.equal(first.active, undefined, 'active solo debe ir en $setOnInsert');
  assert.equal(second.active, undefined, 'active solo debe ir en $setOnInsert');
  assert.equal(first.imageUrl, undefined, 'imageUrl solo debe ir en $setOnInsert');
  assert.equal(second.imageUrl, undefined, 'imageUrl solo debe ir en $setOnInsert');
  assert.equal(firstUpdate.$setOnInsert.active, true);
  assert.equal(firstUpdate.$setOnInsert.imageUrl, undefined);
  assert.equal(secondUpdate.$setOnInsert.active, true);
  assert.equal(secondUpdate.$setOnInsert.imageUrl, 'http://img/2.png');
  assert.deepEqual(
    { code: first.code, name: first.name, price: first.price, priceWithIva: first.priceWithIva },
    { code: 'P1', name: 'Producto Uno', price: 10, priceWithIva: 12.1 },
  );
  assert.deepEqual(first.searchTokens, ['p1', 'producto', 'uno']);
  assert.deepEqual(second.searchTokens, ['p2', 'producto', 'dos']);
  assert.deepEqual(
    {
      code: second.code,
      name: second.name,
      price: second.price,
      priceWithIva: second.priceWithIva,
    },
    {
      code: 'P2',
      name: 'Producto Dos',
      price: 20,
      priceWithIva: 24.2,
    },
  );
  assert.equal(payload.updateMode, 'both');
  assert.equal(payload.updated, 0);
  assert.equal(payload.created, 2);
  assert.match(payload.message, /0 actualizado\(s\) y 2 creado\(s\)/);
});

test('el modo precio actualiza solo precios y conserva nombre, búsqueda, imagen y estado', async () => {
  seedProduct({
    brandName: 'General',
    code: 'P1',
    name: 'Nombre original',
    price: 10,
    priceWithIva: 12.1,
    imageUrl: 'http://img/original.png',
    active: false,
  });

  const response = await importProducts(
    [
      {
        Marca: 'General',
        Codigo: 'P1',
        Nombre: 'Nombre que no debe pisarse',
        'Precio S/IVA': 25,
      },
    ],
    { updateMode: 'price' },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.count, 1);
  assert.equal(payload.updateMode, 'price');
  assert.equal(payload.updated, 1);
  assert.equal(payload.created, 0);

  assert.equal(bulkWriteOps.length, 1);
  const operation = bulkWriteOps[0].updateOne;
  assert.equal(operation.upsert, false, 'el modo precio nunca debe insertar');
  assert.deepEqual(
    Object.keys(operation.update.$set)
      .filter((key) => key !== 'updatedAt')
      .sort(),
    ['brandId', 'code', 'price', 'priceWithIva'],
    'solo se actualizan los precios',
  );
  assert.deepEqual(
    { price: operation.update.$set.price, priceWithIva: operation.update.$set.priceWithIva },
    { price: 25, priceWithIva: 30.25 },
  );
  assert.equal(operation.update.$setOnInsert.active, true);
  assert.equal(operation.update.$setOnInsert.imageUrl, undefined);
  assert.deepEqual(
    {
      name: existingProducts[0].name,
      imageUrl: existingProducts[0].imageUrl,
      active: existingProducts[0].active,
    },
    {
      name: 'Nombre original',
      imageUrl: 'http://img/original.png',
      active: false,
    },
  );
});

test('el modo precio funciona sin columna Nombre y sin columnas de precio completas', async () => {
  seedProduct({ brandName: 'General', code: 'P1', name: 'Nombre original', price: 10 });

  const response = await importProducts(
    [{ Marca: 'General', Codigo: 'P1', 'Precio C/IVA': 24.2 }],
    { updateMode: 'price' },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.count, 1);
  assert.equal(bulkWriteOps.length, 1);
  const set = bulkWriteOps[0].updateOne.update.$set;
  assert.equal(set.name, undefined);
  assert.equal(set.searchName, undefined);
  assert.deepEqual(
    { price: set.price, priceWithIva: set.priceWithIva },
    { price: 20, priceWithIva: 24.2 },
  );
});

test('el modo precio reporta not_found y no crea productos ni marcas nuevas', async () => {
  seedProduct({ brandName: 'General', code: 'P1', name: 'Existente', price: 10 });
  const rows = [
    { Marca: 'General', Codigo: 'P1', 'Precio S/IVA': 15 },
    { Marca: 'Marca Nueva', Codigo: 'NEW-1', 'Precio S/IVA': 15 },
  ];

  const previewResponse = await importProducts(rows, {
    dryRun: true,
    updateMode: 'price',
  });
  const preview = await previewResponse.json();

  assert.equal(previewResponse.status, 200);
  assert.equal(preview.updateMode, 'price');
  assert.equal(preview.valid, 1);
  assert.equal(preview.updateCount, 1);
  assert.equal(preview.createCount, 0);
  assert.deepEqual(preview.newBrands, [], 'los modos de un campo no crean marcas');
  const notFound = preview.errors.find((error: any) => error.kind === 'not_found');
  assert.ok(notFound, 'la fila inexistente debe reportarse como not_found');
  assert.equal(notFound.row, 3);
  assert.equal(notFound.field, 'codigo');
  assert.match(notFound.reason, /modo Solo precio/);
  assert.equal(bulkWriteOps.length, 0, 'el preview no debe escribir productos');
  assert.equal(brandInsertCalls.length, 0, 'el preview no debe crear marcas');

  const response = await importProducts(rows, { updateMode: 'price' });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.count, 1);
  assert.equal(payload.skipped, 1);
  assert.equal(bulkWriteOps.length, 1, 'solo la fila existente genera una operación');
  assert.equal(bulkWriteOps[0].updateOne.filter.code, 'P1');
  assert.equal(brandInsertCalls.length, 0, 'no debe crear la marca de la fila inexistente');
});

test('el modo nombre actualiza nombre y búsqueda sin tocar precios, imagen ni estado', async () => {
  seedProduct({
    brandName: 'General',
    code: 'P1',
    name: 'Nombre original',
    price: 10,
    priceWithIva: 12.1,
    imageUrl: 'http://img/original.png',
    active: false,
  });

  const response = await importProducts(
    [
      {
        Marca: 'General',
        Codigo: 'P1',
        Nombre: 'Nombre Nuevo',
        'Precio S/IVA': -5,
        'Precio C/IVA': 'no-es-un-numero',
      },
    ],
    { updateMode: 'name' },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.count, 1);
  assert.equal(payload.updateMode, 'name');
  assert.equal(payload.updated, 1);
  assert.equal(payload.created, 0);

  assert.equal(bulkWriteOps.length, 1);
  const operation = bulkWriteOps[0].updateOne;
  assert.equal(operation.upsert, false, 'el modo nombre nunca debe insertar');
  assert.deepEqual(
    Object.keys(operation.update.$set)
      .filter((key) => key !== 'updatedAt')
      .sort(),
    ['brandId', 'code', 'name', 'searchCode', 'searchName', 'searchTokens'],
    'solo se actualizan el nombre y los campos de búsqueda',
  );
  assert.equal(operation.update.$set.name, 'Nombre Nuevo');
  assert.deepEqual(operation.update.$set.searchTokens, ['p1', 'nombre', 'nuevo']);
  assert.equal(operation.update.$setOnInsert.active, true);
  assert.equal(operation.update.$setOnInsert.imageUrl, undefined);
  assert.equal(existingProducts[0].price, 10);
  assert.equal(existingProducts[0].active, false);
});

test('el modo nombre funciona sin columnas de precio', async () => {
  seedProduct({ brandName: 'General', code: 'P1', name: 'Nombre original', price: 10 });

  const response = await importProducts(
    [{ Marca: 'General', Codigo: 'P1', Nombre: 'Solo Nombre' }],
    { updateMode: 'name' },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.count, 1);
  assert.equal(bulkWriteOps.length, 1);
  assert.equal(bulkWriteOps[0].updateOne.update.$set.name, 'Solo Nombre');
  assert.equal(bulkWriteOps[0].updateOne.update.$set.price, undefined);
});

test('el modo nombre reporta not_found y no crea productos ni marcas nuevas', async () => {
  seedProduct({ brandName: 'General', code: 'P1', name: 'Existente', price: 10 });
  const rows = [
    { Marca: 'General', Codigo: 'P1', Nombre: 'Actualizado' },
    { Marca: 'Marca Nueva', Codigo: 'NEW-NAME', Nombre: 'No debe crearse' },
  ];

  const previewResponse = await importProducts(rows, {
    dryRun: true,
    updateMode: 'name',
  });
  const preview = await previewResponse.json();

  assert.equal(previewResponse.status, 200);
  assert.equal(preview.valid, 1);
  assert.equal(preview.updateCount, 1);
  assert.equal(preview.createCount, 0);
  assert.deepEqual(preview.newBrands, []);
  const notFound = preview.errors.find((error: any) => error.kind === 'not_found');
  assert.ok(notFound);
  assert.match(notFound.reason, /modo Solo nombre/);
  assert.equal(brandInsertCalls.length, 0);
  assert.equal(bulkWriteOps.length, 0);

  const response = await importProducts(rows, { updateMode: 'name' });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.count, 1);
  assert.equal(payload.skipped, 1);
  assert.equal(brandInsertCalls.length, 0, 'el modo nombre no crea marcas');
  assert.equal(bulkWriteOps.length, 1);
  assert.equal(bulkWriteOps[0].updateOne.filter.code, 'P1');
});

test('el modo ambos actualiza nombre y precios y conserva imagen y estado del existente', async () => {
  seedProduct({
    brandName: 'General',
    code: 'P1',
    name: 'Nombre original',
    price: 10,
    priceWithIva: 12.1,
    imageUrl: 'http://img/original.png',
    active: false,
  });

  const response = await importProducts(
    [
      {
        Marca: 'General',
        Codigo: 'P1',
        Nombre: 'Nombre Actualizado',
        'Precio S/IVA': 30,
        Imagen: 'http://img/nueva.png',
      },
    ],
    { updateMode: 'both' },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.count, 1);
  assert.equal(payload.updateMode, 'both');
  assert.equal(payload.updated, 1);
  assert.equal(payload.created, 0);

  const operation = bulkWriteOps[0].updateOne;
  assert.equal(operation.upsert, true);
  assert.deepEqual(
    {
      name: operation.update.$set.name,
      price: operation.update.$set.price,
      priceWithIva: operation.update.$set.priceWithIva,
    },
    { name: 'Nombre Actualizado', price: 30, priceWithIva: 36.3 },
  );
  assert.equal(operation.update.$set.imageUrl, undefined);
  assert.equal(operation.update.$set.active, undefined);
  assert.equal(operation.update.$setOnInsert.active, true);
  assert.equal(operation.update.$setOnInsert.imageUrl, 'http://img/nueva.png');
  assert.equal(existingProducts[0].active, false);
  assert.equal(existingProducts[0].imageUrl, 'http://img/original.png');
});

test('el modo ambos crea productos nuevos con imagen, estado activo y búsqueda', async () => {
  setBrands(['General', 'Marca Nueva']);

  const response = await importProducts([
    {
      Marca: 'Marca Nueva',
      Codigo: 'NEW-1',
      Nombre: 'Producto Nuevo',
      'Precio S/IVA': 50,
      Imagen: 'http://img/nuevo.png',
    },
  ]);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.count, 1);
  assert.equal(payload.updated, 0);
  assert.equal(payload.created, 1);

  const operation = bulkWriteOps[0].updateOne;
  assert.equal(operation.upsert, true);
  assert.equal(operation.update.$set.name, 'Producto Nuevo');
  assert.equal(operation.update.$set.price, 50);
  assert.equal(operation.update.$set.priceWithIva, 60.5);
  assert.deepEqual(operation.update.$set.searchTokens, ['new', '1', 'producto', 'nuevo']);
  assert.equal(operation.update.$setOnInsert.active, true);
  assert.equal(operation.update.$setOnInsert.imageUrl, 'http://img/nuevo.png');
  assert.equal(operation.update.$set.active, undefined);
  assert.equal(operation.update.$set.imageUrl, undefined);
});

test('en modo ambos distingue un precio 0 explícito de un precio ausente', async () => {
  seedProduct({ brandName: 'General', code: 'P1', name: 'Existente', price: 10 });
  const rows = [
    { Marca: 'General', Codigo: 'P1', Nombre: 'Precio Cero', 'Precio S/IVA': 0 },
    { Marca: 'General', Codigo: 'P2', Nombre: 'Sin precio' },
  ];

  const previewResponse = await importProducts(rows, {
    dryRun: true,
    updateMode: 'both',
  });
  const preview = await previewResponse.json();

  assert.equal(previewResponse.status, 200);
  assert.equal(preview.valid, 1);
  assert.equal(preview.updateCount, 1);
  assert.equal(preview.createCount, 0);
  assert.equal(preview.errors.length, 1);
  assert.equal(preview.errors[0].row, 3);
  assert.match(preview.errors[0].reason, /Falta el precio/);

  const response = await importProducts(rows, { updateMode: 'both' });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.count, 1);
  assert.equal(payload.skipped, 1);
  const set = bulkWriteOps[0].updateOne.update.$set;
  assert.deepEqual(
    { price: set.price, priceWithIva: set.priceWithIva },
    { price: 0, priceWithIva: 0 },
  );
});

test('rechaza un modo de actualización inválido antes de escribir', async () => {
  const response = await importProducts(
    [{ Marca: 'General', Codigo: 'P1', Nombre: 'Producto', 'Precio S/IVA': 10 }],
    { updateMode: 'otro' },
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.match(payload.error, /Modo de actualización inválido/);
  assert.equal(bulkWriteOps.length, 0);
  assert.equal(brandInsertCalls.length, 0);
});

test('el import de clientes guarda el descuento general con el encabezado DescuentoGeneral', async () => {
  const response = await importClients(
    [
      {
        Codigo: 'CL1',
        Nombre: 'Cliente Uno',
        Direccion: 'Calle 1',
        Ciudad: 'CABA',
        DescuentoGeneral: 10,
      },
    ],
    { updateMode: 'price' },
  );
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.success, true);
  assert.equal(payload.count, 1);

  assert.equal(clientBulkWriteOps.length, 1, 'la fila válida debe llegar al driver');
  const set = clientBulkWriteOps[0].updateOne.update.$set;
  assert.deepEqual(
    {
      code: set.code,
      name: set.name,
      address: set.address,
      localidad: set.localidad,
      generalDiscount: set.generalDiscount,
    },
    {
      code: 'CL1',
      name: 'Cliente Uno',
      address: 'Calle 1',
      localidad: 'CABA',
      generalDiscount: 10,
    },
  );
  assert.deepEqual(set.searchTokens, ['cl1', 'cliente', 'uno', 'calle', '1', 'caba']);
});

test('descarta productos con precios NaN o negativos y reporta las filas omitidas', async () => {
  const response = await importProducts([
    { Marca: 'General', Codigo: 'OK', Nombre: 'Producto válido', 'Precio S/IVA': 10 },
    { Marca: 'General', Codigo: 'NEG', Nombre: 'Precio negativo', 'Precio S/IVA': -5 },
    {
      Marca: 'General',
      Codigo: 'NAN',
      Nombre: 'Precio no numérico',
      'Precio S/IVA': 'no-es-un-numero',
    },
    {
      Marca: 'General',
      Codigo: 'MIX',
      Nombre: 'Negativo con IVA válido',
      'Precio S/IVA': -1,
      'Precio C/IVA': 10,
    },
  ]);
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.count, 1);
  assert.equal(payload.skipped, 3);
  assert.match(payload.message, /3 fila\(s\) omitida\(s\)/);
  assert.equal(bulkWriteOps.length, 1, 'solo la fila con precios válidos llega al driver');
  assert.equal(bulkWriteOps[0].updateOne.update.$set.code, 'OK');
});

test('el modo preview no escribe y devuelve total, válidos, omitidos y errores por fila', async () => {
  const response = await importProducts(
    [
      { Marca: 'General', Codigo: 'OK', Nombre: 'Producto válido', 'Precio S/IVA': 10 },
      { Marca: 'General', Codigo: '', Nombre: 'Sin código', 'Precio S/IVA': 10 },
      { Marca: 'General', Codigo: 'NEG', Nombre: 'Precio negativo', 'Precio S/IVA': -1 },
    ],
    { dryRun: true },
  );
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.success, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.total, 3);
  assert.equal(payload.valid, 1);
  assert.equal(payload.skipped, 2);
  assert.equal(payload.duplicates, 0);
  assert.equal(payload.errorCount, 2);
  assert.equal(payload.updateMode, 'both');
  assert.equal(payload.updateCount, 0);
  assert.equal(payload.createCount, 1);
  assert.deepEqual(
    payload.errors.map((error: any) => error.row),
    [3, 4],
    'los errores deben informar la fila real del archivo',
  );
  assert.match(payload.errors[0].reason, /código/i);
  assert.match(payload.errors[1].reason, /negativo/i);
  assert.equal(bulkWriteOps.length, 0, 'el preview no debe escribir productos');
  assert.equal(brandInsertCalls.length, 0, 'el preview no debe crear marcas');
});

test('el preview acepta el flag dryRun como campo del FormData (checkbox)', async () => {
  const response = await importClients(
    [
      { Codigo: 'OK', Nombre: 'Cliente válido', DescuentoGeneral: 10 },
      { Codigo: 'BAD', Nombre: 'Descuento inválido', DescuentoGeneral: 150 },
    ],
    { dryRunInForm: true },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.valid, 1);
  assert.equal(payload.skipped, 1);
  assert.equal(payload.updateMode, undefined, 'clientes no usa el modo de productos');
  assert.equal(clientBulkWriteOps.length, 0, 'el preview no debe escribir clientes');
});

test('el preview devuelve como máximo 50 errores pero cuenta todos', async () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    Marca: 'General',
    Codigo: '',
    Nombre: `Producto ${index}`,
    'Precio S/IVA': 10,
  }));
  const response = await importProducts(rows, { dryRun: true });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.total, 60);
  assert.equal(payload.valid, 0);
  assert.equal(payload.skipped, 60);
  assert.equal(payload.errors.length, 50);
  assert.equal(payload.errorCount, 60);
  assert.equal(payload.errorsTruncated, true);
  assert.equal(bulkWriteOps.length, 0);
});

test('normaliza marcas y resuelve "Bagó" sin duplicar BAGO', async () => {
  setBrands(['General', 'Bagó']);
  const bagoId = brandIdOf('Bagó');

  const response = await importProducts([
    { Marca: ' Bagó ', Codigo: 'B1', Nombre: 'Producto Bagó 1', 'Precio S/IVA': 10 },
    { Marca: 'BAGO', Codigo: 'B2', Nombre: 'Producto Bagó 2', 'Precio S/IVA': 10 },
    { Marca: 'bago', Codigo: 'B3', Nombre: 'Producto Bagó 3', 'Precio S/IVA': 10 },
  ]);
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.count, 3);
  assert.equal(brandInsertCalls.length, 0, 'no debe crear una marca que ya existe normalizada');
  assert.equal(bulkWriteOps.length, 3);

  for (const op of bulkWriteOps) {
    assert.equal(
      String(op.updateOne.filter.brandId),
      String(bagoId),
      'todas las variantes deben apuntar a la marca existente',
    );
  }
});

test('crea una sola marca cuando el archivo trae variantes nuevas de la misma', async () => {
  const response = await importProducts([
    { Marca: ' Bagó ', Codigo: 'N1', Nombre: 'Nuevo 1', 'Precio S/IVA': 10 },
    { Marca: 'BAGO', Codigo: 'N2', Nombre: 'Nuevo 2', 'Precio S/IVA': 10 },
  ]);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.count, 2);
  assert.deepEqual(brandInsertCalls, [['BAGO']]);
  assert.equal(brands.filter((brand) => brand.name === 'BAGO').length, 1);
  assert.equal(brands.filter((brand) => brand.name === 'Bagó').length, 0);
});

test('rechaza descuentos generales fuera de 0-100 o no numéricos', async () => {
  const rows = [
    { Codigo: 'C1', Nombre: 'Descuento alto', DescuentoGeneral: 150 },
    { Codigo: 'C2', Nombre: 'Descuento negativo', DescuentoGeneral: -1 },
    { Codigo: 'C3', Nombre: 'Descuento no numérico', DescuentoGeneral: 'abc' },
    { Codigo: 'C4', Nombre: 'Descuento límite', DescuentoGeneral: 100 },
    { Codigo: 'C5', Nombre: 'Sin descuento', DescuentoGeneral: '' },
  ];

  const previewResponse = await importClients(rows, { dryRun: true });
  const preview = await previewResponse.json();

  assert.equal(previewResponse.status, 200);
  assert.equal(preview.total, 5);
  assert.equal(preview.valid, 2);
  assert.equal(preview.skipped, 3);
  assert.deepEqual(
    preview.errors.map((error: any) => error.row),
    [2, 3, 4],
  );
  assert.match(preview.errors[0].reason, /entre 0 y 100/);
  assert.match(preview.errors[1].reason, /entre 0 y 100/);
  assert.match(preview.errors[2].reason, /número válido/);
  assert.equal(clientBulkWriteOps.length, 0, 'el preview no debe escribir clientes');

  const response = await importClients(rows);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.count, 2);
  assert.equal(payload.skipped, 3);
  assert.equal(clientBulkWriteOps.length, 2);
  assert.deepEqual(
    clientBulkWriteOps.map((op) => op.updateOne.update.$set.generalDiscount),
    [100, 0],
  );
});

test('reporta códigos duplicados dentro del archivo y no los importa dos veces', async () => {
  const rows = [
    { Marca: 'Bagó', Codigo: 'DUP', Nombre: 'Primero', 'Precio S/IVA': 10 },
    { Marca: 'BAGO', Codigo: 'DUP', Nombre: 'Segundo', 'Precio S/IVA': 20 },
    { Marca: 'General', Codigo: 'OK', Nombre: 'Tercero', 'Precio S/IVA': 30 },
  ];

  const previewResponse = await importProducts(rows, { dryRun: true });
  const preview = await previewResponse.json();

  assert.equal(previewResponse.status, 200);
  assert.equal(preview.total, 3);
  assert.equal(preview.valid, 2);
  assert.equal(preview.skipped, 1);
  assert.equal(preview.duplicates, 1);
  const duplicate = preview.errors.find((error: any) => error.kind === 'duplicate');
  assert.ok(duplicate, 'debe informar el duplicado del archivo');
  assert.equal(duplicate.row, 3);
  assert.match(duplicate.reason, /fila 2/);
  assert.equal(bulkWriteOps.length, 0);
  assert.equal(brandInsertCalls.length, 0, 'el preview no debe crear marcas faltantes');

  const response = await importProducts(rows);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.count, 2);
  assert.equal(payload.skipped, 1);
  assert.equal(bulkWriteOps.length, 2, 'el duplicado no debe generar un segundo upsert');
});

test('rechaza un archivo con más de 5000 filas en vez de importarlo parcialmente', async () => {
  const rows = Array.from({ length: 5001 }, (_, index) => ({
    Marca: 'General',
    Codigo: `P${index}`,
    Nombre: `Producto ${index}`,
    'Precio S/IVA': 10,
  }));
  const response = await importProducts(rows);
  const payload = await response.json();

  assert.equal(
    response.status,
    400,
    `se esperaba 400 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /5000 filas/);
  assert.equal(bulkWriteOps.length, 0, 'no debe escribir nada de un archivo rechazado');
});

test('rechaza archivos de más de 5 MB', async () => {
  const response = await importPayload(
    Buffer.alloc(5 * 1024 * 1024 + 1),
    'productos.xlsx',
    'products',
  );
  const payload = await response.json();

  assert.equal(
    response.status,
    400,
    `se esperaba 400 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /5 MB/);
});

test('importa productos desde CSV con exceljs', async () => {
  const csv = 'Marca,Codigo,Nombre,Precio S/IVA\nGeneral,CSV1,Producto CSV,15\n';
  const response = await importPayload(csv, 'productos.csv', 'products');
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.count, 1);
  assert.equal(bulkWriteOps.length, 1);
  const set = bulkWriteOps[0].updateOne.update.$set;
  assert.deepEqual(
    { code: set.code, name: set.name, price: set.price, priceWithIva: set.priceWithIva },
    { code: 'CSV1', name: 'Producto CSV', price: 15, priceWithIva: 18.15 },
  );
});

test('rechaza .xls con un error claro (exceljs solo lee .xlsx y .csv)', async () => {
  const response = await importPayload(Buffer.from('legacy'), 'productos.xls', 'products');
  const payload = await response.json();

  assert.equal(
    response.status,
    400,
    `se esperaba 400 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /\.xlsx o \.csv/);
});
