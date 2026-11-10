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
import { backfillSearchFields, SEARCH_MIGRATIONS } from '../lib/search-backfill';
import { PUT as updateBrand } from '../app/api/brands/[id]/route';
import { authRequest } from './test-auth-utils';

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
  assert.equal(normalizeSearchText('DermaPlus'), 'dermaplus');
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
          productName: 'Shampoo NovaFarma 400ml',
          brandName: 'DermaPlus',
        },
        {
          productCode: 'AC-200',
          productName: 'Acondicionador',
          brandName: 'DermaPlus',
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
        'novafarma',
        '400ml',
        'dermaplus',
        'ac',
        '200',
        'acondicionador',
      ],
    },
  );

  // Tokens repetidos entre cliente e ítems no se duplican.
  assert.deepEqual(
    buildOrderSearchFields({ clientName: 'DermaPlus', items: [{ brandName: 'DERMÁPLUS' }] })
      .searchTokens,
    ['dermaplus'],
  );
});

test('los hooks completan las claves al guardar y al actualizar', async () => {
  const brand = await Brand.create({ name: 'DermaPlus' });
  assert.equal(brand.searchName, 'dermaplus');

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
    name: 'Yerba DermaPlus',
    price: 100,
  });
  assert.deepEqual(buildProductSearchFields(product), {
    searchName: 'yerba dermaplus',
    searchCode: 'n-10',
    searchTokens: ['n', '10', 'yerba', 'dermaplus'],
  });
});

test('Order sincroniza shortId y searchTokens al crear e insertar en lote', async () => {
  const productId = new mongoose.Types.ObjectId();
  const item = {
    productId,
    productCode: 'SH-400',
    productName: 'Shampoo NovaFarma 400ml',
    brandName: 'DermaPlus',
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
    'novafarma',
    '400ml',
    'dermaplus',
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
          productName: 'Shampoo NovaFarma',
          brandName: 'DermaPlus',
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
  assert.ok(order?.searchTokens.includes('dermaplus'));

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
  const brand = await Brand.create({ name: 'NovaFarma' });
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
    name: 'Shampoo NovaFarma 400ml',
    price: 100,
  });
  await Product.create({
    brandId: brand._id,
    code: 'SH-200',
    name: 'Shampoo NovaFarma 200ml',
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
    'Shampoo NovaFarma 400ml',
  ]);
  assert.deepEqual(await productNames(buildProductSearchFilter('novafarma')), [
    'Shampoo NovaFarma 200ml',
    'Shampoo NovaFarma 400ml',
  ]);
});

test('el nombre de la marca se indexa y se encuentra en cualquier orden', async () => {
  const brand = await Brand.create({ name: 'BioSalud' });
  const created = await Product.create({
    brandId: brand._id,
    code: 'JAB-400',
    name: 'Jabón Líquido 400ml',
    price: 100,
  });
  await Product.create({
    brandId: brand._id,
    code: 'JAB-200',
    name: 'Jabón Líquido 200ml',
    price: 100,
  });

  assert.ok(
    created.searchTokens.includes('biosalud'),
    'Product.create resuelve el nombre de la marca para searchTokens',
  );

  const matchingBrands = (await Brand.find(buildBrandSearchFilter('biosalud 400')!)
    .select('_id name')
    .lean()) as unknown as Array<{ _id: unknown; name: string }>;
  assert.deepEqual(
    matchingBrands.map((item) => item.name),
    ['BioSalud'],
    'la marca se resuelve por cualquiera de los tokens',
  );

  const productNames = async (filter: Record<string, unknown> | null) =>
    (
      await Product.find(filter ?? {})
        .sort({ name: -1 })
        .lean()
    ).map((product) => product.name);

  const expectedByTerm: Record<string, string[]> = {
    'biosalud jabon': ['Jabón Líquido 400ml', 'Jabón Líquido 200ml'],
    'biosalud 400': ['Jabón Líquido 400ml'],
    'jabon biosalud': ['Jabón Líquido 400ml', 'Jabón Líquido 200ml'],
    '400 biosalud': ['Jabón Líquido 400ml'],
  };

  for (const [term, expected] of Object.entries(expectedByTerm)) {
    assert.deepEqual(
      await productNames(buildProductSearchFilter(term, matchingBrands)),
      expected,
      `la marca debe resolver "${term}"`,
    );
    assert.deepEqual(
      await productNames(buildProductSearchFilter(term)),
      expected,
      `los documentos migrados no deben depender de Brand.find para "${term}"`,
    );
  }

  assert.deepEqual(await productNames(buildProductSearchFilter('biosalud')), [
    'Jabón Líquido 400ml',
    'Jabón Líquido 200ml',
  ]);
});

test('PUT /api/brands/[id] renombra la marca y actualiza searchTokens/updatedAt de sus productos', async () => {
  const brand = await Brand.create({ name: 'BioSalud' });
  const product = await Product.create({
    brandId: brand._id,
    code: 'JAB-400',
    name: 'Jabón Líquido 400ml',
    price: 100,
  });
  const previousUpdatedAt = product.updatedAt;

  await new Promise((resolve) => setTimeout(resolve, 10));

  const response = await updateBrand(
    authRequest(`http://localhost/api/brands/${brand._id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nueva Marca', codePrefix: 'NM' }),
    }),
    { params: Promise.resolve({ id: String(brand._id) }) },
  );

  assert.equal(response.status, 200);
  const updated = await Product.findById(product._id).lean();
  assert.ok(updated);
  assert.deepEqual(updated.searchTokens, [
    'jab',
    '400',
    'jabon',
    'liquido',
    '400ml',
    'nueva',
    'marca',
  ]);
  assert.ok(
    updated.updatedAt.getTime() > previousUpdatedAt.getTime(),
    'updatedAt debe avanzar para que el snapshot offline incremental reciba el cambio',
  );

  const matchingBrands = (await Brand.find(buildBrandSearchFilter('nueva jabon')!)
    .select('_id name')
    .lean()) as unknown as Array<{ _id: unknown; name: string }>;
  assert.deepEqual(
    (
      await Product.find(buildProductSearchFilter('nueva jabon', matchingBrands) ?? {})
        .sort({ name: 1 })
        .lean()
    ).map((item) => item.name),
    ['Jabón Líquido 400ml'],
  );
  assert.deepEqual(
    await Product.find(buildProductSearchFilter('biosalud jabon') ?? {}).lean(),
    [],
    'el token de la marca anterior no debe quedar en searchTokens',
  );
});

test('el backfill de productos resuelve el nombre de la marca', async () => {
  const inserted = await Brand.collection.insertMany([{ name: 'BioSalud' }]);
  await Product.collection.insertMany([
    {
      brandId: inserted.insertedIds[0],
      code: 'JAB-400',
      name: 'Jabón Líquido 400ml',
      price: 1,
    },
  ]);

  const productMigration = SEARCH_MIGRATIONS.filter((migration) => migration.label === 'products');
  const [report] = await backfillSearchFields({ migrations: productMigration });
  assert.deepEqual(report, { label: 'products', scanned: 1, changed: 1 });

  const product = await Product.findOne({ code: 'JAB-400' }).lean();
  assert.deepEqual(product?.searchTokens, ['jab', '400', 'jabon', 'liquido', '400ml', 'biosalud']);

  const [second] = await backfillSearchFields({ migrations: productMigration });
  assert.equal(second.changed, 0, 'la segunda corrida no escribe nada');
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
    items: [item('SH-400', 'Shampoo NovaFarma 400ml', 'DermaPlus')],
  });
  await Order.create({
    clientId: new mongoose.Types.ObjectId(),
    clientName: 'Supermercado Central',
    clientCode: 'CLI-2000',
    createdBy: 'vendedor-otro',
    items: [item('AC-200', 'Acondicionador', 'DermaPlus')],
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
  const brand = await Brand.create({ name: 'Sistema de Gestión de Inventario Labs' });
  const clients = Array.from({ length: 300 }, (_, index) => {
    const name =
      index % 50 === 0 ? `Sistema de Gestión de Inventario Cliente ${index}` : `Cliente ${index}`;
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
      const name =
        index % 50 === 0
          ? `Sistema de Gestión de Inventario Producto ${index}`
          : `Producto ${index}`;
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

  const matchingBrands = (await Brand.find(buildBrandSearchFilter('MOD')!)
    .select('_id name')
    .lean()) as unknown as Array<{ _id: unknown; name: string }>;
  const productFilter = buildProductSearchFilter('MOD', matchingBrands)!;
  const productCount = await mongoose.connection.db!.command({
    explain: { count: Product.collection.collectionName, query: productFilter },
    verbosity: 'executionStats',
  });
  assert.ok(!JSON.stringify(productCount.queryPlanner.winningPlan).includes('COLLSCAN'));

  await Order.insertMany(
    Array.from({ length: 300 }, (_, index) => ({
      clientId: new mongoose.Types.ObjectId(),
      clientName:
        index % 50 === 0 ? `Sistema de Gestión de Inventario Cliente ${index}` : `Cliente ${index}`,
      clientCode: index % 100 === 0 ? `MOD-${index}` : `C-${index}`,
      createdBy: 'vendedor-gomez',
      status: 'borrador',
      items: [
        {
          productId: new mongoose.Types.ObjectId(),
          productCode: `P-${index}`,
          productName:
            index % 50 === 0
              ? `Sistema de Gestión de Inventario Producto ${index}`
              : `Producto ${index}`,
          brandName: 'Sistema de Gestión de Inventario Labs',
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
  assert.deepEqual(buildBrandSearchFields({ name: '  BioSalud ' }), { searchName: 'biosalud' });
});
