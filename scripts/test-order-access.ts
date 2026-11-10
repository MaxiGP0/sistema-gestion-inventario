/**
 * Pruebas del alcance de lectura de pedidos:
 * - Política pura de lib/order-access.ts (admin/controlador/billing vs vendedor).
 * - GET /api/orders agrega el filtro del vendedor y no toca el de los roles
 *   operativos.
 * - GET /api/orders/[id] responde 403 cuando un vendedor intenta leer un
 *   pedido ajeno, pero mantiene el acceso de admin/controlador/billing.
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa y se
 * stubbean los statics de Order antes de importar los route handlers.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { Order } from '../models/Order';
import { User } from '../models/User';
import { buildOrderReadFilter, canListAllOrders, canReadOrder } from '../lib/order-access';
import type { UserRole } from '../lib/authz';
import { invalidateCurrentSessionCache } from '../lib/current-session-cache';
import { authRequest } from './test-auth-utils';

const OWNER_ID = '0000000000000000000000a1';
const OTHER_ID = '0000000000000000000000b2';
const SESSION_USERNAME = 'test-vendedor';

interface CurrentUserRecord {
  _id: string;
  username: string;
  role: UserRole;
  active: boolean;
  sessionVersion: number;
  notificationsEnabled: boolean;
}

const currentUsers = new Map<string, CurrentUserRecord>();

/** Estado actual que devolverá el `User.findById` falso de requireCurrentSession. */
function setCurrentUser(
  userId: string,
  role: UserRole,
  {
    active = true,
    sessionVersion = 0,
    username = `test-${role}`,
  }: { active?: boolean; sessionVersion?: number; username?: string } = {},
): CurrentUserRecord {
  const record: CurrentUserRecord = {
    _id: userId,
    username,
    role,
    active,
    sessionVersion,
    notificationsEnabled: true,
  };

  currentUsers.set(userId, record);
  invalidateCurrentSessionCache(userId);
  return record;
}

let listQuery: any = null;
let detailOrder: any = null;

let GET_LIST: (request: Request) => Promise<Response>;
let GET_DETAIL: (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

const fakeListQuery = (query: any) => {
  listQuery = query;
  const chain: any = {
    select: () => chain,
    slice: () => chain,
    populate: () => chain,
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    lean: async () => [],
  };
  return chain;
};

const fakeDetailQuery = () => {
  const chain: any = {
    populate: () => chain,
    lean: async () => detailOrder,
  };
  return chain;
};

const listOrders = async (
  role: UserRole,
  queryString = '?status=borrador&archived=false',
  userId = OWNER_ID,
  dbRole: UserRole = role,
) => {
  setCurrentUser(userId, dbRole, { username: `test-${dbRole}` });
  listQuery = null;
  const response = await GET_LIST(
    authRequest(`http://localhost/api/orders${queryString}`, {}, role, userId),
  );
  return {
    status: response.status,
    json: await response.json(),
    query: listQuery,
    headers: response.headers,
  };
};

const getOrder = async (role: UserRole, order: any, userId = OWNER_ID) => {
  setCurrentUser(userId, role, { username: `test-${role}` });
  detailOrder = order;
  const response = await GET_DETAIL(
    authRequest(`http://localhost/api/orders/${order._id}`, {}, role, userId),
    { params: Promise.resolve({ id: String(order._id) }) },
  );
  return { status: response.status, json: await response.json() };
};

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Order as any, 'countDocuments', async () => 0);
  mock.method(Order as any, 'find', (query: any) => fakeListQuery(query));
  mock.method(Order as any, 'findById', () => fakeDetailQuery());

  // GET /api/orders y GET /api/orders/[id] ahora usan requireCurrentSession.
  mock.method(User as any, 'findById', (id: unknown) => {
    const record = currentUsers.get(String(id));
    const chain: any = {
      select: () => chain,
      lean: async () => (record ? { ...record } : null),
    };
    return chain;
  });

  GET_LIST = (await import('../app/api/orders/route')).GET;
  ({ GET: GET_DETAIL } = await import('../app/api/orders/[id]/route'));
});

beforeEach(() => {
  currentUsers.clear();
  invalidateCurrentSessionCache();
});

after(() => mock.restoreAll());

// ---------------------------------------------------------------------------
// Política pura
// ---------------------------------------------------------------------------

test('canListAllOrders conserva el alcance de admin, controlador y billing', () => {
  assert.equal(canListAllOrders('admin'), true);
  assert.equal(canListAllOrders('controlador'), true);
  assert.equal(canListAllOrders('billing'), true);
  assert.equal(canListAllOrders('vendedor'), false);
});

test('canReadOrder deja al vendedor ver sólo sus pedidos y los históricos propios', () => {
  const session = { userId: OWNER_ID, username: SESSION_USERNAME, role: 'vendedor' as const };
  const ownId = new mongoose.Types.ObjectId(OWNER_ID);
  const otherId = new mongoose.Types.ObjectId(OTHER_ID);

  assert.equal(canReadOrder(session, { createdById: OWNER_ID, createdBy: 'otro' }), true);
  assert.equal(canReadOrder(session, { createdById: ownId, createdBy: 'otro' }), true);
  assert.equal(
    canReadOrder(session, { createdById: OTHER_ID, createdBy: SESSION_USERNAME }),
    false,
  );
  assert.equal(canReadOrder(session, { createdById: otherId, createdBy: 'otro' }), false);

  // Históricos: sin createdById manda el username denormalizado.
  assert.equal(canReadOrder(session, { createdBy: SESSION_USERNAME }), true);
  assert.equal(canReadOrder(session, { createdById: null, createdBy: SESSION_USERNAME }), true);
  assert.equal(canReadOrder(session, { createdBy: 'otro-vendedor' }), false);
});

test('canReadOrder deja pasar a los roles operativos sin importar el creador', () => {
  for (const role of ['admin', 'controlador', 'billing'] as const) {
    assert.equal(
      canReadOrder(
        { userId: OWNER_ID, username: 'operador', role },
        { createdById: OTHER_ID, createdBy: 'otro' },
      ),
      true,
      role,
    );
  }
});

test('buildOrderReadFilter sólo filtra al vendedor', () => {
  assert.equal(
    buildOrderReadFilter({ userId: OWNER_ID, username: SESSION_USERNAME, role: 'admin' }),
    null,
  );

  assert.deepEqual(
    buildOrderReadFilter({
      userId: OWNER_ID,
      username: SESSION_USERNAME,
      role: 'vendedor',
    }),
    {
      $or: [{ createdById: OWNER_ID }, { createdById: null, createdBy: SESSION_USERNAME }],
    },
  );
});

// ---------------------------------------------------------------------------
// GET /api/orders
// ---------------------------------------------------------------------------

test('GET /api/orders agrega el filtro del vendedor y conserva los demás filtros', async () => {
  const { status, query } = await listOrders(
    'vendedor',
    '?status=borrador&archived=false&search=Cliente',
  );

  assert.equal(status, 200);
  assert.deepEqual(query.$or, [
    { createdById: OWNER_ID },
    { createdById: null, createdBy: SESSION_USERNAME },
  ]);
  assert.equal(query.status, 'borrador');
  assert.equal(query.archived, false);
  assert.equal(query.$text, undefined);
  assert.deepEqual(query.$and[0].$or[0], {
    searchTokens: { $all: [/^cliente/] },
  });
});

test('GET /api/orders no filtra por creador a admin, controlador ni billing', async () => {
  for (const role of ['admin', 'controlador', 'billing'] as const) {
    const { status, query } = await listOrders(role, '?status=borrador&archived=false');

    assert.equal(status, 200, role);
    assert.equal(query.$or, undefined, `${role} no debe recibir el $or del vendedor`);
    assert.equal(query.createdById, undefined, `${role} no debe filtrar por createdById`);
  }
});

test('GET /api/orders responde 401 a un usuario desactivado y borra la cookie', async () => {
  setCurrentUser(OWNER_ID, 'vendedor', { active: false });

  const response = await GET_LIST(
    authRequest(
      'http://localhost/api/orders?status=borrador&archived=false',
      {},
      'vendedor',
      OWNER_ID,
    ),
  );

  assert.equal(response.status, 401);
  assert.match(response.headers.get('set-cookie') || '', /Max-Age=0/i);
});

test('un vendedor con cookie emitida como admin no puede listar pedidos ajenos', async () => {
  // La cookie dice `admin`, pero el usuario actual es vendedor: manda la base.
  const { status, query } = await listOrders(
    'admin',
    '?status=borrador&archived=false',
    OWNER_ID,
    'vendedor',
  );

  assert.equal(status, 200);
  assert.deepEqual(query.$or, [
    { createdById: OWNER_ID },
    { createdById: null, createdBy: SESSION_USERNAME },
  ]);
});

test('una cookie con sessionVersion vieja no puede listar pedidos', async () => {
  setCurrentUser(OWNER_ID, 'vendedor', { sessionVersion: 1 });

  const response = await GET_LIST(
    authRequest(
      'http://localhost/api/orders?status=borrador&archived=false',
      {},
      'vendedor',
      OWNER_ID,
      0,
    ),
  );

  assert.equal(response.status, 401, 'una baja/cambio de rol invalida la cookie anterior');
  assert.match(response.headers.get('set-cookie') || '', /Max-Age=0/i);
});

// ---------------------------------------------------------------------------
// GET /api/orders/[id]
// ---------------------------------------------------------------------------

test('GET /api/orders/[id] devuelve 200 al vendedor dueño del pedido', async () => {
  const order = {
    _id: new mongoose.Types.ObjectId(),
    createdById: OWNER_ID,
    createdBy: 'otro-vendedor',
    items: [],
  };

  const { status, json } = await getOrder('vendedor', order);

  assert.equal(status, 200);
  assert.equal(json.order._id, String(order._id));
});

test('GET /api/orders/[id] devuelve 200 al vendedor de un pedido histórico propio', async () => {
  const order = {
    _id: new mongoose.Types.ObjectId(),
    createdBy: SESSION_USERNAME,
    items: [],
  };

  const { status } = await getOrder('vendedor', order);

  assert.equal(status, 200);
});

test('GET /api/orders/[id] devuelve 403 al vendedor por un pedido ajeno', async () => {
  const order = {
    _id: new mongoose.Types.ObjectId(),
    createdById: OTHER_ID,
    createdBy: 'otro-vendedor',
    items: [],
  };

  const { status, json } = await getOrder('vendedor', order);

  assert.equal(status, 403);
  assert.match(json.error, /autorizado/i);
});

test('GET /api/orders/[id] no habilita el fallback por username si el id es ajeno', async () => {
  const order = {
    _id: new mongoose.Types.ObjectId(),
    createdById: OTHER_ID,
    createdBy: SESSION_USERNAME,
    items: [],
  };

  const { status } = await getOrder('vendedor', order);

  assert.equal(status, 403);
});

test('GET /api/orders/[id] devuelve 403 al vendedor por un histórico de otro username', async () => {
  const order = {
    _id: new mongoose.Types.ObjectId(),
    createdBy: 'otro-vendedor',
    items: [],
  };

  const { status } = await getOrder('vendedor', order);

  assert.equal(status, 403);
});

test('GET /api/orders/[id] mantiene el acceso de admin, controlador y billing', async () => {
  const order = {
    _id: new mongoose.Types.ObjectId(),
    createdById: OTHER_ID,
    createdBy: 'otro-vendedor',
    items: [],
  };

  for (const role of ['admin', 'controlador', 'billing'] as const) {
    const { status } = await getOrder(role, order);
    assert.equal(status, 200, role);
  }
});
