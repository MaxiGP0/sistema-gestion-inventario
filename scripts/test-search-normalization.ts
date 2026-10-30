/**
 * Pruebas de normalización, backfill idempotente y uso de índices de prefijo.
 *
 * Cubre clientes, productos, marcas y pedidos. Usa MongoDB en memoria porque
 * las garantías de hooks, bulkWrite e índices dependen del motor real.
 * Complementa a test-client-indexes/test-product-indexes/test-order-indexes,
 * que verifican la forma de la consulta sin base.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { Brand } from '../models/Brand';
import { Client } from '../models/Client';
import { Order } from '../models/Order';
import { Product } from '../models/Product';
import {
  buildBrandSearchFields,
  buildClientSearchFields,
  buildOrderSearchFields,
  buildProductSearchFields,
  normalizeSearchText,
  tokenizeSearchText,
} from '../lib/search-normalize';
import {
  buildBrandSearchFilter,
  buildClientSearchFilter,
  buildProductSearchFilter,
} from '../lib/search-query';
import { buildOrderListQuery } from '../lib/order-query';
import { orderShortId } from '../lib/order-short-id';
import { backfillSearchFields } from '../lib/search-backfill';

let mongo: MongoMemoryServer;

before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { dbName: 'sgi-search-test' } });
  await mongoose.connect(mongo.getUri('sgi-search-test'));
  // dbConnect() reutiliza esta conexión sin abrir otra ni validar MONGODB_URI.
  (globalThis as { mongoose?: unknown }).mongoose = { conn: mongoose, promise: null };
  await Promise.all([
    Brand.createIndexes(),
    Client.createIndexes(),
    Product.createIndexes(),
    Order.createIndexes(),
  ]);
});

beforeEach(async () => {
  await Promise.all([
    Brand.deleteMany({}),
    Client.deleteMany({}),
    Product.deleteMany({}),
    Order.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test('normaliza mayúsculas, acentos y tokens', () => {
  assert.equal(normalizeSearchText('  GÓMEZ   Núñez  '), 'gomez nunez');
  assert.equal(normalizeSearchText('Bagó'), 'bago');
  assert.deepEqual(tokenizeSearchText('Cliente Núñez', 'C-Ñ1'), ['cliente', 'nunez', 'c', 'n1']);
});

test('buildOrderSearchFields combina cliente, vendedor, código corto e ítems', () => {
  assert.deepEqual(
    buildOrderSearchFields({
      clientName: 'Farmacia Núñez',
      clientCode: 'CLI-1042',
      createdBy: 'vendedor-gomez',
      shortId: 'a1b2c3',
      items: [
        {
          productCode: 'SH-400',
          productName: 'Shampoo Capitalis 400ml',
          brandName: 'Bagó',
        },
        {
          productCode: 'AC-200',
          productName: 'Acondicionador',
          brandName: 'Bagó',
        },
      ],
    }),
    {
      searchTokens: [
        'farmacia',
        'nunez',
        'cli',
        '1042',
        'vendedor',
        'gomez',
        'a1b2c3',
        'sh',
        '400',
        'shampoo',
        'capitalis',
        '400ml',
        'bago',
        'ac',
        '200',
        'acondicionador',
      ],
    },
  );

  // Tokens repetidos entre cliente e ítems no se duplican.
  assert.deepEqual(
    buildOrderSearchFields({ clientName: 'Bagó', items: [{ brandName: 'BAGÓ' }] }).searchTokens,
    ['bago'],
  );
});

test('los hooks completan las claves al guardar y al actualizar', async () => {
  const brand = await Brand.create({ name: 'Bagó' });
  assert.equal(brand.searchName, 'bago');

  const client = await Client.create({
    code: 'C-Ñ1',
    name: 'José  María GÓMEZ',
    address: 'Av. Córdoba 123',
    localidad: 'Río Cuarto',
    province: 'Córdoba',
  });
  assert.deepEqual(buildClientSearchFields(client), {
    searchName: 'jose maria gomez',
    searchCode: 'c-n1',
    searchLocalidad: 'rio cuarto',
    searchProvince: 'cordoba',
    searchAddress: 'av. cordoba 123',
    searchTokens: ['c', 'n1', 'jose', 'maria', 'gomez', 'av', 'cordoba', '123', 'rio', 'cuarto'],
  });

  const updated = await Client.findByIdAndUpdate(client._id, { name: 'NÚÑEZ, Ana' }, { new: true });
  assert.equal(updated?.searchName, 'nunez, ana');
  assert.equal(updated?.searchCode, 'c-n1', 'un update de nombre no borra searchCode');
  assert.ok(
    updated?.searchTokens.includes('nunez') && updated?.searchTokens.includes('ana'),
    'el update parcial agrega las palabras del nombre nuevo',
  );
  assert.ok(
    !updated?.searchTokens.includes('gomez') && updated?.searchTokens.includes('c'),
    'el update parcial conserva las palabras de los campos que no cambiaron',
  );

  const untouched = await Client.findByIdAndUpdate(
    client._id,
    { generalDiscount: 10 },
    { new: true },
  );
  assert.equal(untouched?.searchName, 'nunez, ana');

  const product = await Product.create({
    brandId: brand._id,
    code: 'Ñ-10',
    name: 'Yerba Bagó',
    price: 100,
  });
  assert.deepEqual(buildProductSearchFields(product), {
    searchName: 'yerba bago',
    searchCode: 'n-10',
    searchTokens: ['n', '10', 'yerba', 'bago'],
  });
});

test('Order sincroniza shortId y searchTokens al crear e insertar en lote', async () => {
  const productId = new mongoose.Types.ObjectId();
  const item = {
    productId,
    productCode: 'SH-400',
    productName: 'Shampoo Capitalis 400ml',
    brandName: 'Bagó',
    unitPrice: 100,
    requestedQuantity: 2,
    verifiedQuantity: 0,
    isPending: false,
    itemDiscount: 0,
    lineTotal: 200,
  };

  const order = await Order.create({
    clientId: new mongoose.Types.ObjectId(),
    clientName: 'Farmacia Núñez',
    clientCode: 'CLI-1042',
    createdBy: 'vendedor-gomez',
    items: [item],
  });

  assert.equal(order.shortId, orderShortId(order._id));
  assert.deepEqual(order.searchTokens, [
    'farmacia',
    'nunez',
    'cli',
    '1042',
    'vendedor',
    'gomez',
    orderShortId(order._id),
    'sh',
    '400',
    'shampoo',
    'capitalis',
    '400ml',
    'bago',
  ]);

  const [inserted] = await Order.insertMany([
    {
      clientId: new mongoose.Types.ObjectId(),
      clientName: 'Cliente En Lote',
      clientCode: 'LOTE-1',
      createdBy: 'vendedor-lote',
      items: [{ ...item, productCode: 'AC-200', productName: 'Acondicionador' }],
    },
  ]);
  const stored = await Order.findById(inserted._id).lean();

  assert.equal(stored?.shortId, orderShortId(inserted._id));
  assert.ok(stored?.searchTokens.includes('lote'));
  assert.ok(stored?.searchTokens.includes('acondicionador'));
  assert.equal(stored?.searchTokens.filter((token) => token === 'acondicionador').length, 1);
});

test('el backfill es idempotente y sólo completa documentos históricos', async () => {
  await Brand.collection.insertMany([{ name: 'Marca Vieja' }]);
  await Client.collection.insertMany([
    {
      code: 'C-1',
      name: 'Cliente Histórico',
      localidad: 'Rosario',
      province: 'Santa Fe',
      address: '',
    },
    { code: 'C-2', name: 'Gómez', localidad: '', province: '', address: '' },
  ]);
  await Product.collection.insertMany([
    { brandId: new mongoose.Types.ObjectId(), code: 'P-1', name: 'Producto Viejo', price: 1 },
  ]);
  const legacyOrderId = new mongoose.Types.ObjectId();
  await Order.collection.insertMany([
    {
      _id: legacyOrderId,
      clientId: new mongoose.Types.ObjectId(),
      clientName: 'Cliente Histórico',
      clientCode: 'C-2',
      createdBy: 'vendedor-viejo',
      status: 'borrador',
      items: [
        {
          productId: new mongoose.Types.ObjectId(),
          productCode: 'SH-400',
          productName: 'Shampoo Capitalis',
          brandName: 'Bagó',
        },
      ],
      subtotal: 0,
      totalDiscount: 0,
      finalTotal: 0,
      archived: false,
      comments: [],
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
      updatedAt: new Date('2026-01-01T12:00:00.000Z'),
    },
  ]);

  const first = await backfillSearchFields({ batchSize: 1 });
  assert.deepEqual(
    first.map(({ label, scanned, changed }) => ({ label, scanned, changed })),
    [
      { label: 'brands', scanned: 1, changed: 1 },
      { label: 'clients', scanned: 2, changed: 2 },
      { label: 'products', scanned: 1, changed: 1 },
      { label: 'orders', scanned: 1, changed: 1 },
    ],
  );

  const client = await Client.findOne({ code: 'C-2' }).lean();
  assert.equal(client?.searchName, 'gomez');
  assert.equal(client?.searchCode, 'c-2');
  assert.deepEqual(client?.searchTokens, ['c', '2', 'gomez']);

  const order = await Order.findById(legacyOrderId).lean();
  assert.equal(order?.shortId, orderShortId(legacyOrderId));
  assert.ok(order?.searchTokens.includes('historico'));
  assert.ok(order?.searchTokens.includes('shampoo'));
  assert.ok(order?.searchTokens.includes('bago'));

  const second = await backfillSearchFields({ batchSize: 1 });
  assert.ok(
    second.every((report) => report.changed === 0),
    'la segunda corrida no escribe nada',
  );

  // El dry-run detecta cambios sin persistirlos.
  await Client.collection.updateOne({ code: 'C-2' }, { $set: { searchName: 'desactualizado' } });
  const dry = await backfillSearchFields({ dryRun: true });
  assert.equal(dry.find((report) => report.label === 'clients')?.changed, 1);
  const stillStale = await Client.findOne({ code: 'C-2' }).lean();
  assert.equal(stillStale?.searchName, 'desactualizado');
});

test('la búsqueda multi-token encuentra palabras en cualquier posición', async () => {
  const brand = await Brand.create({ name: 'Capitalis' });
  await Client.create({
    code: 'C-AHORRO',
    name: 'Supermercado El Ahorro',
    address: 'Av. Siempre Viva 742',
    localidad: 'Rosario',
    province: 'Santa Fe',
  });
  await Client.create({
    code: 'C-OTRO',
    name: 'Supermercado Central',
    address: '',
    localidad: 'CABA',
    province: 'Buenos Aires',
  });
  await Product.create({
    brandId: brand._id,
    code: 'SH-400',
    name: 'Shampoo Capitalis 400ml',
    price: 100,
  });
  await Product.create({
    brandId: brand._id,
    code: 'SH-200',
    name: 'Shampoo Capitalis 200ml',
    price: 100,
  });

  const names = async (filter: Record<string, unknown> | null) =>
    (
      await Client.find(filter ?? {})
        .sort({ name: 1 })
        .lean()
    ).map((client) => client.name);
  const productNames = async (filter: Record<string, unknown> | null) =>
    (
      await Product.find(filter ?? {})
        .sort({ name: 1 })
        .lean()
    ).map((product) => product.name);

  assert.deepEqual(await names(buildClientSearchFilter('ahorro')), ['Supermercado El Ahorro']);
  assert.deepEqual(await names(buildClientSearchFilter('super ahorro')), [
    'Supermercado El Ahorro',
  ]);
  assert.deepEqual(await productNames(buildProductSearchFilter('shampoo 400')), [
    'Shampoo Capitalis 400ml',
  ]);
  assert.deepEqual(await productNames(buildProductSearchFilter('capitalis')), [
    'Shampoo Capitalis 200ml',
    'Shampoo Capitalis 400ml',
  ]);
});

test('la búsqueda de pedidos por tokens encuentra cliente, producto y código corto', async () => {
  const item = (productCode: string, productName: string, brandName: string) => ({
    productId: new mongoose.Types.ObjectId(),
    productCode,
    productName,
    brandName,
    unitPrice: 100,
    requestedQuantity: 1,
    verifiedQuantity: 0,
    isPending: false,
    itemDiscount: 0,
    lineTotal: 100,
  });

  const ahorro = await Order.create({
    clientId: new mongoose.Types.ObjectId(),
    clientName: 'Supermercado El Ahorro',
    clientCode: 'CLI-1042',
    createdBy: 'vendedor-gomez',
    items: [item('SH-400', 'Shampoo Capitalis 400ml', 'Bagó')],
  });
  await Order.create({
    clientId: new mongoose.Types.ObjectId(),
    clientName: 'Supermercado Central',
    clientCode: 'CLI-2000',
    createdBy: 'vendedor-otro',
    items: [item('AC-200', 'Acondicionador', 'Bagó')],
  });

  // Pedido histórico sin searchTokens: se resuelve por el fallback de regex.
  const historicalId = new mongoose.Types.ObjectId();
  await Order.collection.insertMany([
    {
      _id: historicalId,
      clientId: new mongoose.Types.ObjectId(),
      clientName: 'Cliente Legacy',
      clientCode: 'VIEJO-1',
      createdBy: 'vendedor-viejo',
      status: 'borrador',
      items: [item('P-1', 'Producto Viejo', 'Marca Vieja')],
      subtotal: 0,
      totalDiscount: 0,
      finalTotal: 0,
      archived: false,
      comments: [],
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
      updatedAt: new Date('2026-01-01T12:00:00.000Z'),
    },
  ]);

  const session = { userId: '0000000000000000000000a1', username: 'admin', role: 'admin' as const };
  const idsFor = async (search: string) => {
    const result = buildOrderListQuery(session, { archived: 'false', search });
    assert.equal(result.ok, true);
    if (!result.ok) return [];

    return (await Order.find(result.query).sort({ createdAt: -1 }).lean()).map((order) =>
      String(order._id),
    );
  };

  assert.deepEqual(await idsFor('ahor'), [String(ahorro._id)]);
  assert.deepEqual(await idsFor('shampoo 400'), [String(ahorro._id)]);
  assert.deepEqual(await idsFor(`#${ahorro.shortId}`), [String(ahorro._id)]);
  assert.deepEqual(await idsFor('legacy'), [String(historicalId)]);
});

test('la búsqueda por prefijo no hace COLLSCAN ni en el listado ni en el count', async () => {
  const brand = await Brand.create({ name: 'Modular Labs' });
  const clients = Array.from({ length: 300 }, (_, index) => {
    const name = index % 50 === 0 ? `Modular Cliente ${index}` : `Cliente ${index}`;
    const code = index % 100 === 0 ? `MOD-${index}` : `C-${index}`;
    return {
      code,
      name,
      address: '',
      localidad: 'Rosario',
      province: 'Santa Fe',
      ...buildClientSearchFields({ name, code }),
    };
  });
  await Client.insertMany(clients);
  await Product.insertMany(
    Array.from({ length: 300 }, (_, index) => {
      const name = index % 50 === 0 ? `Modular Producto ${index}` : `Producto ${index}`;
      const code = index % 100 === 0 ? `MOD-${index}` : `P-${index}`;
      return {
        brandId: brand._id,
        code,
        name,
        price: 1,
        priceWithIva: 1,
        ...buildProductSearchFields({ name, code }),
      };
    }),
  );

  const clientFilter = buildClientSearchFilter('MOD')!;
  const clientPlan = await Client.collection
    .find(clientFilter)
    .sort({ name: 1, _id: 1 })
    .limit(25)
    .explain('executionStats');
  const clientCount = await mongoose.connection.db!.command({
    explain: { count: Client.collection.collectionName, query: clientFilter },
    verbosity: 'executionStats',
  });

  assert.ok(!JSON.stringify(clientPlan.queryPlanner.winningPlan).includes('COLLSCAN'));
  assert.ok(!JSON.stringify(clientCount.queryPlanner.winningPlan).includes('COLLSCAN'));
  assert.ok(
    JSON.stringify(clientPlan.queryPlanner.winningPlan).includes('searchTokens') ||
      JSON.stringify(clientPlan.queryPlanner.winningPlan).includes('searchName') ||
      JSON.stringify(clientPlan.queryPlanner.winningPlan).includes('searchCode'),
    'el listado debe usar un índice de búsqueda',
  );

  const brandIds = (await Brand.find(buildBrandSearchFilter('MOD')!).select('_id').lean()).map(
    (item) => item._id,
  );
  const productFilter = buildProductSearchFilter('MOD', brandIds)!;
  const productCount = await mongoose.connection.db!.command({
    explain: { count: Product.collection.collectionName, query: productFilter },
    verbosity: 'executionStats',
  });
  assert.ok(!JSON.stringify(productCount.queryPlanner.winningPlan).includes('COLLSCAN'));

  await Order.insertMany(
    Array.from({ length: 300 }, (_, index) => ({
      clientId: new mongoose.Types.ObjectId(),
      clientName: index % 50 === 0 ? `Modular Cliente ${index}` : `Cliente ${index}`,
      clientCode: index % 100 === 0 ? `MOD-${index}` : `C-${index}`,
      createdBy: 'vendedor-gomez',
      status: 'borrador',
      items: [
        {
          productId: new mongoose.Types.ObjectId(),
          productCode: `P-${index}`,
          productName: index % 50 === 0 ? `Modular Producto ${index}` : `Producto ${index}`,
          brandName: 'Modular Labs',
          unitPrice: 1,
          requestedQuantity: 1,
          verifiedQuantity: 0,
          isPending: false,
          itemDiscount: 0,
          lineTotal: 1,
        },
      ],
      subtotal: 0,
      totalDiscount: 0,
      finalTotal: 0,
      archived: false,
      comments: [],
    })),
  );

  const orderQuery = buildOrderListQuery(
    { userId: '0000000000000000000000a1', username: 'admin', role: 'admin' },
    { archived: 'false', search: 'MOD' },
  );
  assert.equal(orderQuery.ok, true);
  if (!orderQuery.ok) return;

  const orderPlan = await Order.collection
    .find(orderQuery.query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(25)
    .explain('executionStats');
  assert.ok(!JSON.stringify(orderPlan.queryPlanner.winningPlan).includes('COLLSCAN'));
  assert.ok(
    JSON.stringify(orderPlan.queryPlanner.winningPlan).includes('searchTokens'),
    'los pedidos deben resolver la búsqueda con el índice multikey',
  );
});

test('buildBrandSearchFields normaliza el nombre de la marca', () => {
  assert.deepEqual(buildBrandSearchFields({ name: '  Algabó ' }), { searchName: 'algabo' });
});
