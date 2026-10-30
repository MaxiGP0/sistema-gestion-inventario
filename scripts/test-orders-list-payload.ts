/**
 * Prueba de GET /api/orders (listado): las tarjetas de depósito / facturación
 * reciben cliente reducido, totales, contexto comercial, snapshots de las
 * líneas y sólo el último comentario. El payload sigue liviano: no incluye
 * productos poblados, marcas, precios de línea ni el historial de comentarios.
 *
 * También verifica la paginación por cursor (`createdAt`/`_id`) que usan los
 * listados de depósito y facturación con "cargar más", y conserva la
 * compatibilidad con page/limit/skip para otros clientes.
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa y se
 * stubbean los statics de Order/Client antes de importar el route handler. El
 * fake de query aplica la proyección y el populate pedidos por el route (igual
 * que Mongo) para poder afirmar sobre el JSON final.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { Client } from '../models/Client';
import { Order } from '../models/Order';
import {
  buildOrderProductPreview,
  getOrderLastComment,
  getOrderPendingSummary,
} from '../lib/order-card-preview';
import { buildOrderCursorFilter, decodeOrderCursor, encodeOrderCursor } from '../lib/order-cursor';
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId();

const brandId = oid();
const productId = oid();
const clientId = oid();
const itemId = oid();
const secondItemId = oid();
const thirdItemId = oid();

// Documentos "completos" tal como estarían guardados en MongoDB.
const fullClient: any = {
  _id: clientId,
  code: 'C1',
  name: 'Cliente Demo',
  address: 'Calle 123',
  localidad: 'Rosario',
  province: 'Santa Fe',
  generalDiscount: 10,
  brandDiscounts: [
    { brandId: { _id: brandId, name: 'Marca Demo', codePrefix: 'MD' }, discountPercentage: 15 },
  ],
};

const fullProduct: any = {
  _id: productId,
  code: 'P1',
  name: 'Producto Demo',
  price: 100,
  priceWithIva: 121,
  brandId: { _id: brandId, name: 'Marca Demo', codePrefix: 'MD' },
  imageUrl: 'https://example.com/p1.png',
};

const fullOrder: any = {
  _id: oid(),
  clientId, // referencia sin poblar
  clientName: 'Cliente Demo',
  clientCode: 'C1',
  status: 'borrador',
  items: [
    {
      _id: itemId,
      productId, // referencia sin poblar
      productCode: 'P1',
      productName: 'Shampoo Capitalis',
      unitPrice: 100,
      requestedQuantity: 3,
      verifiedQuantity: 1,
      isPending: true,
      pendingReason: 'Sin stock en depósito',
      itemDiscount: 10,
      lineTotal: 180,
    },
    {
      _id: secondItemId,
      productId,
      productCode: 'P2',
      productName: 'Acondicionador Capitalis',
      unitPrice: 100,
      requestedQuantity: 2,
      verifiedQuantity: 2,
      isPending: false,
      itemDiscount: 0,
      lineTotal: 200,
    },
    {
      _id: thirdItemId,
      productId,
      productCode: 'P3',
      productName: 'Crema de manos',
      unitPrice: 100,
      requestedQuantity: 1,
      verifiedQuantity: 1,
      isPending: false,
      itemDiscount: 0,
      lineTotal: 100,
    },
  ],
  subtotal: 600,
  totalDiscount: 30,
  finalTotal: 450,
  createdBy: 'vendedor',
  invoiceType: 'A',
  paymentCondition: 'contado',
  comments: [
    {
      text: 'Primer comentario que no debe viajar al listado',
      author: 'vendedor',
      role: 'vendedor',
      createdAt: new Date('2026-01-01T11:00:00.000Z'),
    },
    {
      text: 'Último comentario visible en la tarjeta',
      author: 'deposito',
      role: 'controlador',
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
    },
  ],
  archived: false,
  version: 0,
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-01-02T10:00:00.000Z'),
};

type Capture = {
  findQuery?: any;
  select?: string;
  slice?: { path: string; value: number };
  populates: any[];
  sort?: any;
  skip?: number;
  limit?: number;
};

let capture: Capture;
let GET: (request: Request) => Promise<Response>;
let totalCount = 1;
let clientFindCalls = 0;
let countCalls = 0;
/** Documentos que devuelve la consulta fake; `null` usa el pedido base. */
let leanDocs: any[] | null = null;

const pick = (doc: any, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => key !== '_id').map((key) => [key, doc[key]]));

// Simula la proyección de Mongo: sobreviven el _id y las rutas pedidas.
const applyProjection = (doc: any, select: string | undefined) => {
  if (!select) return doc;
  const paths = select.split(/\s+/).filter(Boolean);
  const itemPaths = paths
    .filter((path) => path.startsWith('items.'))
    .map((path) => path.slice('items.'.length));
  const out: any = { _id: doc._id };
  for (const path of paths) {
    if (path === '_id' || path.startsWith('items.')) continue;
    if (path in doc) {
      out[path] = doc[path];
    }
  }
  if (itemPaths.length > 0) {
    out.items = (doc.items || []).map((item: any) =>
      Object.fromEntries(itemPaths.filter((key) => key in item).map((key) => [key, item[key]])),
    );
  }
  return out;
};

// Simula el `$slice: -1` que la consulta aplica sobre los comentarios.
const applySlice = (order: any, slice: Capture['slice']) => {
  if (!slice || !Array.isArray(order[slice.path])) return order;
  const value = slice.value;

  return {
    ...order,
    [slice.path]: value >= 0 ? order[slice.path].slice(0, value) : order[slice.path].slice(value),
  };
};

// Simula mongoose populate sobre la referencia correspondiente.
const applyPopulate = (order: any, populate: any) => {
  const keys = String(populate?.select || '')
    .split(/\s+/)
    .filter(Boolean);

  if (populate?.path === 'clientId') {
    order.clientId = { _id: fullClient._id, ...pick(fullClient, keys) };
  }

  if (populate?.path === 'items.productId') {
    order.items = (order.items || []).map((item: any) => ({
      ...item,
      productId: { _id: fullProduct._id, ...pick(fullProduct, keys) },
    }));
    for (const nested of [populate.populate].flat().filter(Boolean)) {
      if (nested.path === 'brandId') {
        order.items = order.items.map((item: any) => ({
          ...item,
          productId: { ...item.productId, brandId: fullProduct.brandId },
        }));
      }
    }
  }

  return order;
};

const buildLeanResult = () => {
  return (leanDocs ?? [fullOrder]).map((source) => {
    let order: any = applyProjection(source, capture.select);
    order = applySlice(order, capture.slice);
    for (const populate of capture.populates) {
      order = applyPopulate(order, populate);
    }
    return order;
  });
};

const fakeOrderQuery = (query: any) => {
  capture = { findQuery: query, populates: [] };
  const chain: any = {
    select(select: string) {
      capture.select = select;
      return chain;
    },
    slice(path: string, value: number) {
      capture.slice = { path, value };
      return chain;
    },
    populate(populate: any) {
      capture.populates.push(populate);
      return chain;
    },
    sort(sort: any) {
      capture.sort = sort;
      return chain;
    },
    skip(skip: number) {
      capture.skip = skip;
      return chain;
    },
    limit(limit: number) {
      capture.limit = limit;
      return chain;
    },
    lean: () => buildLeanResult(),
  };
  return chain;
};

const listOrders = async (queryString = '') => {
  const response = await GET(authRequest(`http://localhost/api/orders${queryString}`));
  return { status: response.status, json: await response.json() };
};

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Order as any, 'countDocuments', async () => {
    countCalls += 1;
    return totalCount;
  });
  mock.method(Order as any, 'find', (query: any) => fakeOrderQuery(query));
  mock.method(Client as any, 'find', () => {
    clientFindCalls += 1;
    return {
      select: () => ({ lean: async () => [{ _id: clientId }] }),
    };
  });

  GET = (await import('../app/api/orders/route')).GET;
});

after(() => mock.restoreAll());

test('GET /api/orders devuelve el contexto liviano de la tarjeta sin poblar productos', async () => {
  const { status, json } = await listOrders('?status=borrador,paralizado&archived=false');

  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(json.orders.length, 1);

  const [order] = json.orders;

  // Sólo los campos que usan las tarjetas (sin subtotal, unitPrice ni updatedAt).
  // clientName/clientCode viajan como snapshot para no depender del populate.
  assert.deepEqual(Object.keys(order).sort(), [
    '_id',
    'archived',
    'clientCode',
    'clientId',
    'clientName',
    'comments',
    'createdAt',
    'createdBy',
    'finalTotal',
    'invoiceType',
    'items',
    'paymentCondition',
    'status',
    'version',
  ]);
  assert.equal(order.clientName, 'Cliente Demo');
  assert.equal(order.clientCode, 'C1');
  assert.equal(order.version, 0);
  assert.equal(order.invoiceType, 'A');
  assert.equal(order.paymentCondition, 'contado');

  // El cliente viaja sólo con los campos de la tarjeta.
  assert.deepEqual(Object.keys(order.clientId).sort(), [
    '_id',
    'code',
    'localidad',
    'name',
    'province',
  ]);
  assert.equal(order.clientId.address, undefined);
  assert.equal(order.clientId.generalDiscount, undefined);
  assert.equal(order.clientId.brandDiscounts, undefined);

  // Las líneas traen snapshots y cantidades, pero nunca el producto poblado.
  assert.equal(order.items.length, 3);
  assert.deepEqual(Object.keys(order.items[0]).sort(), [
    '_id',
    'isPending',
    'pendingReason',
    'productCode',
    'productName',
    'requestedQuantity',
    'verifiedQuantity',
  ]);
  assert.equal(order.items[0].productId, undefined);
  assert.equal(order.items[0].productName, 'Shampoo Capitalis');
  assert.equal(order.items[0].isPending, true);
  assert.equal(order.items[0].pendingReason, 'Sin stock en depósito');

  // Sólo viaja el último comentario (el historial completo queda en el detalle).
  assert.equal(order.comments.length, 1);
  assert.equal(order.comments[0].text, 'Último comentario visible en la tarjeta');

  // La tarjeta puede armar el adelanto, el faltante y el comentario con este DTO.
  assert.equal(
    buildOrderProductPreview(order),
    '3x Shampoo Capitalis · 2x Acondicionador Capitalis (+1 más)',
  );
  assert.deepEqual(getOrderPendingSummary(order), {
    count: 1,
    reason: 'Sin stock en depósito',
  });
  assert.equal(getOrderLastComment(order), 'Último comentario visible en la tarjeta');

  const payload = JSON.stringify(json);
  assert.ok(!payload.includes('Marca Demo'), 'el listado no debe incluir la marca completa');
  assert.ok(
    !payload.includes('Primer comentario que no debe viajar'),
    'el listado no debe incluir el historial de comentarios',
  );
});

test('GET /api/orders no populea items.productId y reduce el select del cliente', async () => {
  await listOrders();

  assert.equal(
    capture.select,
    'clientId clientName clientCode status finalTotal createdBy createdAt archived version invoiceType paymentCondition items._id items.productName items.productCode items.requestedQuantity items.verifiedQuantity items.isPending items.pendingReason comments',
  );
  assert.deepEqual(capture.slice, { path: 'comments', value: -1 });
  assert.equal(capture.populates.length, 1);
  assert.equal(capture.populates[0].path, 'clientId');
  assert.equal(capture.populates[0].select, 'code name localidad province');
  assert.equal(capture.populates[0].populate, undefined);
  assert.ok(!JSON.stringify(capture.populates).includes('items.productId'));
});

test('GET /api/orders con búsqueda usa searchTokens y no pre-consulta Client', async () => {
  clientFindCalls = 0;
  const { status, json } = await listOrders(
    '?search=Cliente%20Demo&status=borrador&startDate=2026-01-01&endDate=2026-01-31',
  );

  assert.equal(status, 200);
  assert.equal(clientFindCalls, 0, 'la búsqueda no debe pre-consultar Client');
  assert.equal(capture.findQuery.$text, undefined);
  assert.deepEqual(capture.findQuery.$and[0].$or[0], {
    searchTokens: { $all: [/^cliente/, /^demo/] },
  });
  assert.equal(capture.findQuery.$or, undefined, 'no debe armar un $or con ids de clientes');
  assert.equal(capture.findQuery.archived, false);
  assert.equal(capture.findQuery.status, 'borrador');
  assert.ok(capture.findQuery.createdAt.$gte instanceof Date, 'mantiene el filtro de fecha desde');
  assert.ok(capture.findQuery.createdAt.$lte instanceof Date, 'mantiene el filtro de fecha hasta');
  assert.equal(json.orders[0].items[0].productName, 'Shampoo Capitalis');
  assert.ok(!('productId' in json.orders[0].items[0]), 'la búsqueda tampoco puebla productos');
  assert.equal(json.orders[0].comments.length, 1);
});

test('GET /api/orders filtra por clientId (último pedido del cliente)', async () => {
  const { status } = await listOrders(`?clientId=${String(clientId)}&limit=1&pagination=cursor`);

  assert.equal(status, 200);
  assert.equal(capture.findQuery.clientId, String(clientId));

  const invalid = await listOrders('?clientId=no-es-un-object-id');
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /clientId/i);
});

test('GET /api/orders con búsqueda de un ObjectId resuelve directo por _id', async () => {
  clientFindCalls = 0;
  const searchId = String(fullOrder._id);

  const { status } = await listOrders(`?search=${searchId}`);

  assert.equal(status, 200);
  assert.equal(clientFindCalls, 0, 'la búsqueda por id tampoco debe consultar Client');
  assert.equal(capture.findQuery._id, searchId);
  assert.equal(capture.findQuery.$text, undefined);
});

test('GET /api/orders normaliza signos y conserva la búsqueda por prefijo', async () => {
  await listOrders(`?search=${encodeURIComponent('C-1 "Demo"')}`);

  assert.equal(capture.findQuery.$text, undefined);
  assert.deepEqual(capture.findQuery.$and[0].$or[0], {
    searchTokens: { $all: [/^c/, /^1/, /^demo/] },
  });

  await listOrders(`?search=${encodeURIComponent('---')}`);

  assert.equal(capture.findQuery._id, null, 'un término sin tokens no debe listar todo');
  assert.equal(capture.findQuery.$text, undefined);
  assert.equal(capture.findQuery.$and, undefined);
});

test('el cursor de pedidos hace round-trip y rechaza payloads corruptos', () => {
  const order = { _id: oid(), createdAt: new Date('2026-02-03T04:05:06.789Z') };
  const cursor = encodeOrderCursor(order);
  const decoded = decodeOrderCursor(cursor);

  assert.ok(decoded);
  assert.equal(decoded!.createdAt.toISOString(), order.createdAt.toISOString());
  assert.equal(String(decoded!.id), String(order._id));

  const invalidDate = Buffer.from(
    JSON.stringify({ createdAt: 'no-es-fecha', id: String(order._id) }),
  ).toString('base64url');
  const invalidId = Buffer.from(
    JSON.stringify({ createdAt: order.createdAt.toISOString(), id: '123' }),
  ).toString('base64url');

  assert.equal(decodeOrderCursor(invalidDate), null);
  assert.equal(decodeOrderCursor(invalidId), null);
  assert.equal(decodeOrderCursor('%%%'), null);
});

test('GET /api/orders en modo cursor ordena por createdAt+_id y devuelve nextCursor', async () => {
  const cursorDocs = [
    { ...fullOrder, _id: oid(), createdAt: new Date('2026-01-03T10:00:00.000Z') },
    { ...fullOrder, _id: oid(), createdAt: new Date('2026-01-02T10:00:00.000Z') },
    { ...fullOrder, _id: oid(), createdAt: new Date('2026-01-01T10:00:00.000Z') },
  ];
  leanDocs = cursorDocs;
  countCalls = 0;
  totalCount = cursorDocs.length;

  try {
    const { status, json } = await listOrders('?pagination=cursor&limit=2');

    assert.equal(status, 200);
    assert.equal(countCalls, 1, 'la primera página cuenta el total');
    assert.equal(capture.skip, undefined, 'el cursor no debe usar skip');
    assert.equal(capture.limit, 3, 'pide un documento extra para saber si hay más');
    assert.deepEqual(capture.sort, { createdAt: -1, _id: -1 });
    assert.equal(json.orders.length, 2);
    assert.equal(json.pagination.mode, 'cursor');
    assert.equal(json.pagination.limit, 2);
    assert.equal(json.pagination.hasMore, true);
    assert.equal(json.pagination.total, 3);

    const cursor = decodeOrderCursor(json.pagination.nextCursor);
    assert.ok(cursor);
    assert.equal(cursor!.createdAt.toISOString(), cursorDocs[1].createdAt.toISOString());
    assert.equal(String(cursor!.id), String(cursorDocs[1]._id));
  } finally {
    leanDocs = null;
    totalCount = 1;
  }
});

test('GET /api/orders en modo cursor no devuelve nextCursor si no hay más', async () => {
  leanDocs = [{ ...fullOrder, _id: oid() }];
  totalCount = 1;

  try {
    const { status, json } = await listOrders('?pagination=cursor&limit=2');

    assert.equal(status, 200);
    assert.equal(json.orders.length, 1);
    assert.equal(json.pagination.hasMore, false);
    assert.equal(json.pagination.nextCursor, null);
    assert.equal(json.pagination.total, 1);
  } finally {
    leanDocs = null;
  }
});

test('GET /api/orders con cursor filtra después del último pedido y no cuenta', async () => {
  const lastOrder = {
    ...fullOrder,
    _id: oid(),
    createdAt: new Date('2026-01-02T10:00:00.000Z'),
  };
  leanDocs = [lastOrder];
  countCalls = 0;

  try {
    const cursor = encodeOrderCursor(lastOrder);
    const { status } = await listOrders(
      `?pagination=cursor&limit=2&cursor=${encodeURIComponent(cursor)}&search=Cliente`,
    );

    assert.equal(status, 200);
    assert.equal(countCalls, 0, 'las páginas siguientes no ejecutan countDocuments');
    assert.equal(capture.skip, undefined);
    assert.equal(capture.limit, 3);
    assert.deepEqual(capture.findQuery.$and[0].$or[0], {
      searchTokens: { $all: [/^cliente/] },
    });
    assert.deepEqual(capture.findQuery.$and[1], buildOrderCursorFilter(decodeOrderCursor(cursor)!));
  } finally {
    leanDocs = null;
  }
});

test('GET /api/orders rechaza un cursor inválido sin consultar la base', async () => {
  countCalls = 0;
  const { status, json } = await listOrders(
    `?pagination=cursor&cursor=${encodeURIComponent('no-es-un-cursor')}`,
  );

  assert.equal(status, 400);
  assert.match(json.error, /cursor/i);
  assert.equal(countCalls, 0);
});

test('GET /api/orders usa page/limit y devuelve metadatos de paginación', async () => {
  totalCount = 132;
  try {
    const { status, json } = await listOrders('?page=2&limit=50');

    assert.equal(status, 200);
    assert.equal(capture.skip, 50);
    assert.equal(capture.limit, 50);
    assert.deepEqual(capture.sort, { createdAt: -1, _id: -1 });
    assert.deepEqual(json.pagination, { total: 132, page: 2, limit: 50, totalPages: 3 });
  } finally {
    totalCount = 1;
  }
});

test('GET /api/orders pagina con defaults page=1 y limit=100', async () => {
  const { json } = await listOrders();

  assert.equal(capture.skip, 0);
  assert.equal(capture.limit, 100);
  assert.deepEqual(json.pagination, { total: 1, page: 1, limit: 100, totalPages: 1 });
});

test('GET /api/orders normaliza page/limit inválidos y los acota a 1..500', async () => {
  await listOrders('?page=abc&limit=abc');
  assert.equal(capture.skip, 0);
  assert.equal(capture.limit, 100);

  const { json } = await listOrders('?page=0&limit=9999');
  assert.equal(capture.skip, 0);
  assert.equal(capture.limit, 500);
  assert.equal(json.pagination.page, 1);
  assert.equal(json.pagination.limit, 500);
});
