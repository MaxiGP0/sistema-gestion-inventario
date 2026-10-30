/**
 * Pruebas de lib/services/order-read.ts, la lectura compartida por
 * GET /api/orders, GET /api/orders/[id] y los Server Components.
 *
 * Cubre los mismos filtros, proyección, populate y permisos que las rutas,
 * además del cursor y la compatibilidad con page/limit.
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa y se
 * stubbean los statics de Order antes de importar el servicio.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { Order } from '../models/Order';
import type { UserRole } from '../lib/authz';
import { decodeOrderCursor, encodeOrderCursor } from '../lib/order-cursor';
import {
  buildOrderListPage,
  getOrderForSession,
  ORDER_DETAIL_CLIENT_POPULATE,
  ORDER_DETAIL_ITEM_POPULATE,
  ORDER_LIST_CLIENT_POPULATE,
  ORDER_LIST_SELECT,
} from '../lib/services/order-read';

const oid = () => new mongoose.Types.ObjectId();
const OWNER_ID = '0000000000000000000000a1';
const OTHER_ID = '0000000000000000000000b2';
const USERNAME = 'test-vendedor';

const sessionFor = (role: UserRole, userId = OWNER_ID) => ({
  userId,
  username: USERNAME,
  role,
});

type ListCapture = {
  query?: any;
  select?: string;
  slice?: { path: string; value: number };
  populates: any[];
  sort?: any;
  skip?: number;
  limit?: number;
};

let listCapture: ListCapture;
let detailCapture: { populates: any[] };
let leanDocs: any[] = [];
let detailOrder: any = null;
let countCalls = 0;
let findCalls = 0;

const fakeFind = (query: any) => {
  findCalls += 1;
  listCapture = { query, populates: [] };
  const chain: any = {
    select(select: string) {
      listCapture.select = select;
      return chain;
    },
    slice(path: string, value: number) {
      listCapture.slice = { path, value };
      return chain;
    },
    populate(populate: any) {
      listCapture.populates.push(populate);
      return chain;
    },
    sort(sort: any) {
      listCapture.sort = sort;
      return chain;
    },
    skip(skip: number) {
      listCapture.skip = skip;
      return chain;
    },
    limit(limit: number) {
      listCapture.limit = limit;
      return chain;
    },
    lean: async () => {
      const slice = listCapture.slice;
      if (!slice) return leanDocs;

      // Simula el `$slice` de Mongo sobre el último comentario.
      return leanDocs.map((doc) => ({
        ...doc,
        [slice.path]: (doc[slice.path] ?? []).slice(slice.value),
      }));
    },
  };
  return chain;
};

const fakeFindById = () => {
  detailCapture = { populates: [] };
  const chain: any = {
    populate(populate: any) {
      detailCapture.populates.push(populate);
      return chain;
    },
    lean: async () => detailOrder,
  };
  return chain;
};

const orderDoc = (createdAt: string) => ({
  _id: oid(),
  clientId: oid(),
  clientName: 'Cliente Demo',
  clientCode: 'C1',
  status: 'borrador',
  finalTotal: 100,
  createdBy: USERNAME,
  createdById: OWNER_ID,
  createdAt: new Date(createdAt),
  archived: false,
  version: 0,
  invoiceType: 'A',
  paymentCondition: 'contado',
  items: [
    {
      _id: oid(),
      productCode: 'P1',
      productName: 'Shampoo Capitalis',
      requestedQuantity: 3,
      verifiedQuantity: 1,
      isPending: true,
      pendingReason: 'Sin stock en depósito',
    },
    {
      _id: oid(),
      productCode: 'P2',
      productName: 'Acondicionador Capitalis',
      requestedQuantity: 2,
      verifiedQuantity: 2,
      isPending: false,
    },
  ],
  comments: [
    {
      text: 'Primer comentario',
      author: USERNAME,
      role: 'vendedor',
      createdAt: new Date('2026-01-02T10:00:00.000Z'),
    },
    {
      text: 'Último comentario',
      author: USERNAME,
      role: 'vendedor',
      createdAt: new Date('2026-01-03T10:00:00.000Z'),
    },
  ],
});

before(async () => {
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Order as any, 'countDocuments', async () => {
    countCalls += 1;
    return leanDocs.length;
  });
  mock.method(Order as any, 'find', (query: any) => fakeFind(query));
  mock.method(Order as any, 'findById', () => fakeFindById());
});

after(() => mock.restoreAll());

test('buildOrderListPage aplica el filtro del vendedor y la proyección liviana', async () => {
  const docs = [orderDoc('2026-01-03T10:00:00.000Z')];
  leanDocs = docs;
  countCalls = 0;
  findCalls = 0;

  const result = await buildOrderListPage(
    sessionFor('vendedor'),
    { status: 'borrador,paralizado', archived: 'false' },
    null,
    50,
  );

  assert.equal(result.ok, true);
  if (!result.ok || result.mode !== 'cursor') return assert.fail('modo cursor esperado');

  assert.deepEqual(listCapture.query.$or, [
    { createdById: OWNER_ID },
    { createdById: null, createdBy: USERNAME },
  ]);
  assert.deepEqual(listCapture.query.status, { $in: ['borrador', 'paralizado'] });
  assert.equal(listCapture.query.archived, false);
  assert.equal(listCapture.select, ORDER_LIST_SELECT);
  assert.deepEqual(listCapture.slice, { path: 'comments', value: -1 });
  assert.deepEqual(listCapture.populates, [ORDER_LIST_CLIENT_POPULATE]);
  assert.deepEqual(listCapture.sort, { createdAt: -1, _id: -1 });
  assert.equal(listCapture.limit, 51);
  assert.equal(countCalls, 1);
  assert.equal(result.orders.length, 1);
  assert.equal(result.pagination.total, 1);

  // El DTO alcanza para el adelanto, el faltante y el último comentario.
  const [order] = result.orders;
  assert.equal(order.invoiceType, 'A');
  assert.equal(order.paymentCondition, 'contado');
  assert.equal(order.items[0]?.productName, 'Shampoo Capitalis');
  assert.equal(order.items[0]?.requestedQuantity, 3);
  assert.equal(order.items[0]?.verifiedQuantity, 1);
  assert.equal(order.items[0]?.isPending, true);
  assert.equal(order.items[0]?.pendingReason, 'Sin stock en depósito');
  assert.equal((order.items[0] as any)?.productId, undefined);
  assert.equal(order.comments?.length, 1);
  assert.equal(order.comments?.[0]?.text, 'Último comentario');
});

test('ORDER_LIST_SELECT incluye el contexto de tarjeta y excluye el producto poblado', () => {
  const fields = ORDER_LIST_SELECT.split(/\s+/);

  for (const field of [
    'items._id',
    'items.productName',
    'items.productCode',
    'items.requestedQuantity',
    'items.verifiedQuantity',
    'items.isPending',
    'items.pendingReason',
    'invoiceType',
    'paymentCondition',
    'comments',
  ]) {
    assert.ok(fields.includes(field), `falta ${field} en ORDER_LIST_SELECT`);
  }

  assert.ok(!fields.includes('items.productId'));
  assert.ok(!fields.includes('items.unitPrice'));
  assert.ok(!fields.includes('comments.text'));
});

test('buildOrderListPage no filtra por creador a admin, controlador ni billing', async () => {
  leanDocs = [];
  countCalls = 0;

  for (const role of ['admin', 'controlador', 'billing'] as const) {
    const result = await buildOrderListPage(
      sessionFor(role),
      { status: 'borrador', archived: 'false' },
      null,
      50,
    );

    assert.equal(result.ok, true, role);
    assert.equal(listCapture.query.$or, undefined, `${role} no debe recibir $or`);
  }
});

test('buildOrderListPage busca por texto multi-palabra sin perder el alcance del rol', async () => {
  leanDocs = [orderDoc('2026-01-03T10:00:00.000Z')];
  countCalls = 0;

  const result = await buildOrderListPage(
    sessionFor('vendedor'),
    { archived: 'false', search: 'Cliente Demo' },
    null,
    50,
  );

  assert.equal(result.ok, true);
  assert.equal(listCapture.query.$text, undefined);

  const [searchCondition] = listCapture.query.$and;
  assert.deepEqual(searchCondition.$or[0], {
    searchTokens: { $all: [/^cliente/, /^demo/] },
  });
  assert.deepEqual(searchCondition.$or[1].searchTokens, { $exists: false });
  assert.deepEqual(listCapture.query.$or, [
    { createdById: OWNER_ID },
    { createdById: null, createdBy: USERNAME },
  ]);
});

test('buildOrderListPage busca por producto incluido en el pedido', async () => {
  leanDocs = [orderDoc('2026-01-03T10:00:00.000Z')];
  countCalls = 0;

  const result = await buildOrderListPage(
    sessionFor('admin'),
    { archived: 'false', search: 'shampoo 400' },
    null,
    50,
  );

  assert.equal(result.ok, true);
  assert.equal(listCapture.query.$text, undefined);

  const [searchCondition] = listCapture.query.$and;
  assert.deepEqual(searchCondition.$or[0], {
    searchTokens: { $all: [/^shampoo/, /^400/] },
  });

  // Fallback de pedidos históricos: regex `i` sobre los snapshots de línea.
  const [legacyCondition] = searchCondition.$or[1].$and;
  const legacyFields = legacyCondition.$or.map((branch: Record<string, unknown>) =>
    Object.keys(branch).find((key) => key !== '$exists'),
  );
  assert.ok(legacyFields.includes('items.productName'));
  assert.ok(legacyFields.includes('items.productCode'));
  assert.ok(
    legacyCondition.$or.some(
      (branch: Record<string, unknown>) =>
        branch['items.productName'] instanceof RegExp &&
        branch['items.productName'].test('Shampoo Capitalis'),
    ),
  );
});

test('buildOrderListPage encuentra un pedido por #xxxxxx o por 6 caracteres', async () => {
  leanDocs = [orderDoc('2026-01-03T10:00:00.000Z')];
  countCalls = 0;

  const orderId = new mongoose.Types.ObjectId();
  const shortCode = String(orderId).slice(-6);

  for (const term of [`#${shortCode}`, shortCode]) {
    const result = await buildOrderListPage(
      sessionFor('admin'),
      { archived: 'false', search: term },
      null,
      50,
    );

    assert.equal(result.ok, true);
    const combined = listCapture.query.$and[0];

    if (term.startsWith('#')) {
      // `#xxxxxx` explícito: sólo el filtro de código corto.
      const shortFilter = combined;
      assert.equal(shortFilter.$or[0].shortId, shortCode);
      assert.equal(shortFilter.$or[1].$expr.$regexMatch.regex, `^${shortCode}`);
      assert.deepEqual(shortFilter.$or[2].shortId, { $exists: false });
      assert.equal(shortFilter.$or[2].$expr.$regexMatch.regex, `${shortCode}$`);
    } else {
      // Un token hexadecimal de 6 caracteres también puede ser parte de un
      // código/nombre: se combinan shortId y tokens con OR.
      const shortFilter = combined.$or[0];
      assert.equal(shortFilter.$or[0].shortId, shortCode);
      assert.equal(shortFilter.$or[2].$expr.$regexMatch.regex, `${shortCode}$`);
      const tokenFilter = combined.$or[1];
      assert.deepEqual(tokenFilter.$or[0], {
        searchTokens: { $all: [new RegExp(`^${shortCode}`)] },
      });
    }

    assert.equal(listCapture.query.$text, undefined);
  }

  // Un token hexadecimal de 4 caracteres también conserva la búsqueda por
  // texto ("cafe" puede ser parte de un nombre o código).
  await buildOrderListPage(sessionFor('admin'), { archived: 'false', search: 'cafe' }, null, 50);
  assert.equal(listCapture.query.$and[0].$or[0].$or[0].shortId.source, '^cafe');
  assert.deepEqual(listCapture.query.$and[0].$or[1].$or[0], {
    searchTokens: { $all: [/^cafe/] },
  });

  // El ObjectId completo mantiene el atajo directo por _id.
  await buildOrderListPage(
    sessionFor('admin'),
    { archived: 'false', search: String(orderId) },
    null,
    50,
  );
  assert.equal(listCapture.query._id, String(orderId));
  assert.equal(listCapture.query.$and, undefined);
});

test('buildOrderListPage pagina con cursor y devuelve nextCursor', async () => {
  const docs = [
    orderDoc('2026-01-03T10:00:00.000Z'),
    orderDoc('2026-01-02T10:00:00.000Z'),
    orderDoc('2026-01-01T10:00:00.000Z'),
  ];
  leanDocs = docs;
  countCalls = 0;

  const result = await buildOrderListPage(
    sessionFor('admin'),
    { status: 'borrador', archived: 'false' },
    null,
    2,
  );

  assert.equal(result.ok, true);
  if (!result.ok || result.mode !== 'cursor') return assert.fail('modo cursor esperado');

  assert.equal(result.orders.length, 2);
  assert.equal(result.pagination.hasMore, true);
  assert.equal(result.pagination.total, 3);

  const nextCursor = result.pagination.nextCursor;
  assert.ok(nextCursor);
  const cursor = decodeOrderCursor(nextCursor);
  assert.ok(cursor);
  assert.equal(String(cursor!.id), String(docs[1]._id));
  assert.equal(cursor!.createdAt.toISOString(), docs[1].createdAt.toISOString());
});

test('buildOrderListPage con cursor no cuenta y agrega el filtro $and', async () => {
  const docs = [orderDoc('2026-01-02T10:00:00.000Z')];
  leanDocs = docs;
  countCalls = 0;

  const cursor = encodeOrderCursor(docs[0]);
  const result = await buildOrderListPage(
    sessionFor('admin'),
    { status: 'borrador', archived: 'false' },
    cursor,
    50,
  );

  assert.equal(result.ok, true);
  if (!result.ok || result.mode !== 'cursor') return assert.fail('modo cursor esperado');

  assert.equal(countCalls, 0);
  assert.equal(listCapture.query.$and.length, 1);
  assert.equal(result.pagination.total, undefined);
});

test('buildOrderListPage rechaza un cursor inválido sin consultar pedidos', async () => {
  leanDocs = [];
  countCalls = 0;
  findCalls = 0;

  const result = await buildOrderListPage(
    sessionFor('admin'),
    { status: 'borrador', archived: 'false' },
    'no-es-un-cursor',
    50,
  );

  assert.equal(result.ok, false);
  if (result.ok) return assert.fail('debió fallar');
  assert.equal(result.status, 400);
  assert.match(result.error, /cursor/i);
  assert.equal(countCalls, 0);
  assert.equal(findCalls, 0);
});

test('buildOrderListPage conserva page/limit con el mismo sort', async () => {
  leanDocs = [orderDoc('2026-01-03T10:00:00.000Z')];

  const result = await buildOrderListPage(sessionFor('admin'), { archived: 'false' }, null, 50, {
    mode: 'page',
    page: 2,
  });

  assert.equal(result.ok, true);
  if (!result.ok || result.mode !== 'page') return assert.fail('modo page esperado');

  assert.equal(listCapture.skip, 50);
  assert.equal(listCapture.limit, 50);
  assert.deepEqual(result.pagination, {
    total: 1,
    page: 2,
    limit: 50,
    totalPages: 1,
  });
});

test('getOrderForSession usa la proyección completa y respeta canReadOrder', async () => {
  const ownOrder = {
    _id: oid(),
    createdById: OWNER_ID,
    createdBy: 'otro-vendedor',
    items: [],
  };

  detailOrder = ownOrder;
  const own = await getOrderForSession(sessionFor('vendedor'), String(ownOrder._id));

  assert.equal(own.ok, true);
  assert.equal(own.ok && String(own.order._id), String(ownOrder._id));
  assert.deepEqual(detailCapture.populates, [
    ORDER_DETAIL_CLIENT_POPULATE,
    ORDER_DETAIL_ITEM_POPULATE,
  ]);

  detailOrder = {
    _id: oid(),
    createdById: OTHER_ID,
    createdBy: 'otro-vendedor',
    items: [],
  };
  const foreign = await getOrderForSession(sessionFor('vendedor'), String(detailOrder._id));

  assert.equal(foreign.ok, false);
  if (foreign.ok) return assert.fail('debió rechazar el pedido ajeno');
  assert.equal(foreign.status, 403);
  assert.match(foreign.error, /autorizado/i);

  for (const role of ['admin', 'controlador', 'billing'] as const) {
    const allowed = await getOrderForSession(sessionFor(role), String(detailOrder._id));
    assert.equal(allowed.ok, true, role);
  }
});

test('getOrderForSession responde 404 y 400 sin romper la ruta', async () => {
  detailOrder = null;

  const missing = await getOrderForSession(sessionFor('admin'), String(oid()));
  assert.equal(missing.ok, false);
  if (missing.ok) return assert.fail('debió faltar el pedido');
  assert.equal(missing.status, 404);

  const invalid = await getOrderForSession(sessionFor('admin'), 'no-es-un-id');
  assert.equal(invalid.ok, false);
  if (invalid.ok) return assert.fail('debió rechazar el id');
  assert.equal(invalid.status, 400);
});
