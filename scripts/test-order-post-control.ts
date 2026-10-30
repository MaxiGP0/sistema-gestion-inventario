/**
 * Pruebas del control post-facturación por línea:
 * - Helpers puros: los pedidos históricos sin `postControl` cuentan como
 *   pendientes y bloquean la entrega.
 * - PATCH /api/orders/[id]/post-control: solo facturación/admin, valida
 *   versión, estado del pedido y existencia de la línea.
 * - PUT /api/orders/[id]: no permite pasar a `entregado` si queda alguna línea
 *   sin controlar; sí lo permite cuando todas están en `ok` o `diferencia`.
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa y se
 * stubbean los statics de Order/Notification antes de importar los handlers.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { Notification } from '../models/Notification';
import { Order } from '../models/Order';
import { canControlOrderPostItems } from '../lib/authz';
import {
  countUncontrolledPostItems,
  hasUncontrolledPostItems,
  isPostControlPending,
  resolvePostControl,
} from '../lib/order-post-control';
import { resolveItemValues } from '../lib/order-totals';
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId().toString();

let orderDoc: any;
let saveCalls = 0;
let populateCalls = 0;
const notificationsCreated: any[] = [];

let PATCH: (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let PUT: (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const baseItem = (postControl?: string) => ({
  _id: oid(),
  productId: oid(),
  unitPrice: 100,
  requestedQuantity: 3,
  verifiedQuantity: 3,
  isPending: false,
  itemDiscount: 10,
  lineTotal: 270,
  ...(postControl !== undefined ? { postControl } : {}),
});

const seedOrder = ({
  status = 'control_post_factura',
  items = [baseItem('pendiente')],
  version = 0,
}: {
  status?: string;
  items?: any[];
  version?: number;
} = {}) => {
  populateCalls = 0;
  orderDoc = {
    _id: oid(),
    status,
    items,
    subtotal: 300,
    totalDiscount: 30,
    finalTotal: 270,
    comments: [],
    clientId: { name: 'Cliente Test' },
    version,
    populate: async () => {
      populateCalls += 1;
      return orderDoc;
    },
    save: async () => {
      saveCalls += 1;
      orderDoc.version = (orderDoc.version ?? 0) + 1;
    },
  };
};

const patchControl = ({
  itemId = orderDoc.items[0]._id,
  postControl = 'ok',
  version = orderDoc.version,
  role = 'billing',
}: {
  itemId?: string;
  postControl?: string;
  version?: number;
  role?: 'admin' | 'billing' | 'controlador' | 'vendedor';
} = {}) =>
  PATCH(
    authRequest(
      `http://localhost/api/orders/${orderDoc._id}/post-control`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, items: [{ _id: itemId, postControl }] }),
      },
      role,
    ),
    { params: Promise.resolve({ id: orderDoc._id }) },
  );

const putOrder = (
  body: object,
  role: 'admin' | 'billing' | 'controlador' | 'vendedor' = 'billing',
) =>
  PUT(
    authRequest(
      `http://localhost/api/orders/${orderDoc._id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: orderDoc.version, ...body }),
      },
      role,
    ),
    { params: Promise.resolve({ id: orderDoc._id }) },
  );

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  // El PATCH ya no puebla relaciones; el PUT sigue usando populate. El mismo
  // documento responde a ambas formas para no duplicar el stub.
  mock.method(Order as any, 'findById', () => orderDoc);
  mock.method(Notification as any, 'create', async (doc: any) => {
    notificationsCreated.push(doc);
    return doc;
  });

  ({ PATCH } = await import('../app/api/orders/[id]/post-control/route'));
  ({ PUT } = await import('../app/api/orders/[id]/route'));
});

after(() => mock.restoreAll());

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

test('los pedidos históricos sin postControl cuentan como pendientes', () => {
  assert.equal(resolvePostControl(undefined), 'pendiente');
  assert.equal(resolvePostControl(null), 'pendiente');
  assert.equal(resolvePostControl('ok'), 'ok');
  assert.equal(resolvePostControl('diferencia'), 'diferencia');
  assert.equal(resolvePostControl('otro'), 'pendiente');

  assert.equal(isPostControlPending({}), true);
  assert.equal(isPostControlPending({ postControl: 'pendiente' }), true);
  assert.equal(isPostControlPending({ postControl: 'ok' }), false);
  assert.equal(isPostControlPending({ postControl: 'diferencia' }), false);

  assert.equal(
    hasUncontrolledPostItems([{ postControl: 'ok' }, { postControl: 'diferencia' }]),
    false,
  );
  assert.equal(hasUncontrolledPostItems([{ postControl: 'ok' }, {}]), true);
  assert.equal(
    countUncontrolledPostItems([{}, { postControl: 'ok' }, { postControl: 'pendiente' }]),
    2,
  );
});

test('solo facturación y admin pueden controlar las líneas', () => {
  assert.equal(canControlOrderPostItems('billing'), true);
  assert.equal(canControlOrderPostItems('admin'), true);
  assert.equal(canControlOrderPostItems('controlador'), false);
  assert.equal(canControlOrderPostItems('vendedor'), false);
});

test('resolveItemValues conserva el control al re-guardar el picking', () => {
  const existing = {
    _id: oid(),
    productId: oid(),
    unitPrice: 100,
    requestedQuantity: 4,
    itemDiscount: 0,
    postControl: 'ok' as const,
  };

  const values = resolveItemValues(existing, {
    _id: String(existing._id),
    verifiedQuantity: 4,
    isPending: false,
  });

  assert.equal(values.postControl, 'ok');
});

// ---------------------------------------------------------------------------
// PATCH /api/orders/[id]/post-control
// ---------------------------------------------------------------------------

test('facturación marca una línea como OK y la versión avanza', async () => {
  seedOrder({ status: 'facturacion', items: [baseItem('pendiente')] });
  saveCalls = 0;

  const response = await patchControl({ postControl: 'ok' });
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.success, true);
  assert.equal(orderDoc.items[0].postControl, 'ok');
  assert.equal(saveCalls, 1);
  assert.equal(payload.order.version, 1, 'la respuesta debe traer la versión siguiente');
  assert.equal(populateCalls, 0, 'el PATCH no debe poblar cliente ni productos');
  assert.deepEqual(payload.order, {
    _id: String(orderDoc._id),
    status: 'facturacion',
    version: 1,
    items: [{ _id: String(orderDoc.items[0]._id), postControl: 'ok' }],
  });
});

test('facturación marca una línea con diferencia', async () => {
  seedOrder({ status: 'control_post_factura', items: [baseItem('pendiente')] });
  saveCalls = 0;

  const response = await patchControl({ postControl: 'diferencia' });
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(orderDoc.items[0].postControl, 'diferencia');
  assert.equal(saveCalls, 1);
});

test('un estado de control inválido responde 400 y no guarda', async () => {
  seedOrder();
  saveCalls = 0;

  const response = await patchControl({ postControl: 'inventado' });
  const payload = await response.json();

  assert.equal(
    response.status,
    400,
    `se esperaba 400 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /control post-factura/i);
  assert.equal(saveCalls, 0);
});

test('depósito no puede marcar el control post-factura', async () => {
  seedOrder();
  saveCalls = 0;

  const response = await patchControl({ role: 'controlador' });

  assert.equal(response.status, 403);
  assert.equal(saveCalls, 0);
});

test('una versión vieja responde 409 y no guarda el control', async () => {
  seedOrder({ version: 4 });
  saveCalls = 0;

  const response = await patchControl({ version: 3 });
  const payload = await response.json();

  assert.equal(
    response.status,
    409,
    `se esperaba 409 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.code, 'ORDER_VERSION_CONFLICT');
  assert.equal(payload.version, 4);
  assert.equal(saveCalls, 0);
});

test('una línea inexistente responde 404 y no guarda el resto', async () => {
  const item = baseItem('pendiente');
  seedOrder({ items: [item] });
  saveCalls = 0;

  const response = await patchControl({ itemId: oid(), postControl: 'ok' });
  const payload = await response.json();

  assert.equal(
    response.status,
    404,
    `se esperaba 404 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /no encontrado/i);
  assert.equal(orderDoc.items[0].postControl, 'pendiente');
  assert.equal(saveCalls, 0);
});

test('no se controla un pedido ya entregado', async () => {
  seedOrder({ status: 'entregado' });
  saveCalls = 0;

  const response = await patchControl();
  const payload = await response.json();

  assert.equal(
    response.status,
    409,
    `se esperaba 409 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /facturación o control post-factura/i);
  assert.equal(saveCalls, 0);
});

// ---------------------------------------------------------------------------
// PUT /api/orders/[id]: bloqueo de la entrega
// ---------------------------------------------------------------------------

test('no se puede pasar a entregado con líneas sin controlar', async () => {
  seedOrder({
    status: 'control_post_factura',
    items: [baseItem('ok'), baseItem(undefined)],
  });
  saveCalls = 0;

  const response = await putOrder({ status: 'entregado' });
  const payload = await response.json();

  assert.equal(
    response.status,
    409,
    `se esperaba 409 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /sin controlar/i);
  assert.equal(orderDoc.status, 'control_post_factura');
  assert.equal(saveCalls, 0);
});

test('tampoco con líneas explícitamente pendientes', async () => {
  seedOrder({
    status: 'control_post_factura',
    items: [baseItem('ok'), baseItem('pendiente')],
  });
  saveCalls = 0;

  const response = await putOrder({ status: 'entregado' });
  const payload = await response.json();

  assert.equal(
    response.status,
    409,
    `se esperaba 409 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.match(payload.error, /sin controlar/i);
  assert.equal(saveCalls, 0);
});

test('se puede entregar cuando todas las líneas están OK o con diferencia', async () => {
  seedOrder({
    status: 'control_post_factura',
    items: [baseItem('ok'), baseItem('diferencia')],
  });
  saveCalls = 0;

  const response = await putOrder({ status: 'entregado' });
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(payload.success, true);
  assert.equal(orderDoc.status, 'entregado');
  assert.equal(saveCalls, 1);
  assert.equal(notificationsCreated.length, 1);
  assert.equal(notificationsCreated[0].targetRole, 'vendor');
  assert.equal(notificationsCreated[0].title, 'Pedido Entregado');
});

test('marcar todas las líneas habilita la entrega en el flujo real', async () => {
  seedOrder({
    status: 'control_post_factura',
    items: [baseItem('pendiente'), baseItem('pendiente')],
  });
  saveCalls = 0;

  const first = await patchControl({ itemId: orderDoc.items[0]._id, postControl: 'ok' });
  assert.equal(first.status, 200);

  const second = await patchControl({ itemId: orderDoc.items[1]._id, postControl: 'diferencia' });
  assert.equal(second.status, 200);

  const delivered = await putOrder({ status: 'entregado' });
  const payload = await delivered.json();

  assert.equal(
    delivered.status,
    200,
    `se esperaba 200 y llegó ${delivered.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(orderDoc.status, 'entregado');
  assert.equal(saveCalls, 3);
});

test('varias líneas se controlan en un solo PATCH y con una sola versión', async () => {
  seedOrder({
    status: 'control_post_factura',
    items: [baseItem('pendiente'), baseItem('diferencia'), baseItem('pendiente')],
    version: 2,
  });
  saveCalls = 0;

  const response = await PATCH(
    authRequest(
      `http://localhost/api/orders/${orderDoc._id}/post-control`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 2,
          items: [
            { _id: orderDoc.items[0]._id, postControl: 'ok' },
            { _id: orderDoc.items[2]._id, postControl: 'ok' },
          ],
        }),
      },
      'billing',
    ),
    { params: Promise.resolve({ id: orderDoc._id }) },
  );
  const payload = await response.json();

  assert.equal(
    response.status,
    200,
    `se esperaba 200 y llegó ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert.equal(saveCalls, 1, 'las acciones masivas deben guardar una sola vez');
  assert.equal(orderDoc.items[0].postControl, 'ok');
  // La diferencia explícita no se toca en un "marcar todas OK".
  assert.equal(orderDoc.items[1].postControl, 'diferencia');
  assert.equal(orderDoc.items[2].postControl, 'ok');
  assert.equal(payload.order.version, 3);

  const delivered = await putOrder({ status: 'entregado' });
  assert.equal(delivered.status, 200);
  assert.equal(orderDoc.status, 'entregado');
});

test('deshacer el control masivo vuelve a pendiente y bloquea la entrega', async () => {
  seedOrder({
    status: 'control_post_factura',
    items: [baseItem('pendiente'), baseItem('pendiente')],
  });
  saveCalls = 0;

  const marked = await PATCH(
    authRequest(
      `http://localhost/api/orders/${orderDoc._id}/post-control`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: orderDoc.version,
          items: orderDoc.items.map((item: any) => ({ _id: item._id, postControl: 'ok' })),
        }),
      },
      'billing',
    ),
    { params: Promise.resolve({ id: orderDoc._id }) },
  );
  assert.equal(marked.status, 200);
  assert.equal(hasUncontrolledPostItems(orderDoc.items), false);

  const undone = await PATCH(
    authRequest(
      `http://localhost/api/orders/${orderDoc._id}/post-control`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: orderDoc.version,
          items: orderDoc.items.map((item: any) => ({ _id: item._id, postControl: 'pendiente' })),
        }),
      },
      'billing',
    ),
    { params: Promise.resolve({ id: orderDoc._id }) },
  );
  assert.equal(undone.status, 200);
  assert.equal(hasUncontrolledPostItems(orderDoc.items), true);

  const blocked = await putOrder({ status: 'entregado' });
  assert.equal(blocked.status, 409);
  assert.equal(orderDoc.status, 'control_post_factura');
});
