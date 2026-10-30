/**
 * Pruebas de `/api/users/notifications` y del estado leído por usuario:
 * - GET filtra por el rol del usuario de la sesión (no por un userId del
 *   cliente) y superpone read/readAt de NotificationRead.
 * - Las notificaciones descartadas por un usuario no aparecen en su bandeja y
 *   se filtran antes del límite de la página.
 * - Paginación por cursor `createdAt/_id`.
 * - Dos usuarios del mismo rol tienen estados de lectura independientes.
 * - PUT solo actualiza notificationsEnabled del usuario autenticado.
 * - El modelo NotificationRead declara el único userId+notificationId.
 *
 * No requiere base de datos: conexión mongoose falsa + stubs de User y de
 * Notification.aggregate (el listado usa una aggregation con `$lookup`).
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { Notification } from '../models/Notification';
import { NotificationRead } from '../models/NotificationRead';
import { User } from '../models/User';
import {
  dismissReadNotificationsForUser,
  setAllNotificationsReadForUser,
} from '../lib/notifications';
import { authRequest } from './test-auth-utils';

const oid = () => new mongoose.Types.ObjectId();

const USER_A = '0000000000000000000000a1';
const USER_B = '0000000000000000000000b2';
const USER_BILLING = '0000000000000000000000c3';
const USER_ADMIN = '0000000000000000000000d4';
const USER_LEGACY_DEPOSIT = '0000000000000000000000e5';
const USER_VENDOR = '0000000000000000000000f6';
const USER_VENDOR_OTHER = '0000000000000000000000f7';
const VENDOR_USERNAME = 'vendedor-a';
const OTHER_VENDOR_USERNAME = 'vendedor-b';

const readAt = new Date('2026-01-01T10:00:00.000Z');
const dismissedAt = new Date('2026-01-01T11:00:00.000Z');

const depositNotification = {
  _id: oid(),
  title: 'Nuevo borrador',
  message: 'Pedido para depósito',
  targetRole: 'deposit',
  createdAt: new Date('2026-01-01T09:00:00.000Z'),
};
const billingNotification = {
  _id: oid(),
  title: 'Pedido listo',
  message: 'Pedido para facturación',
  targetRole: 'billing',
  createdAt: new Date('2026-01-01T09:05:00.000Z'),
};
const globalNotification = {
  _id: oid(),
  title: 'Aviso global',
  message: 'Aviso para todos',
  targetRole: 'all',
  createdAt: new Date('2026-01-01T09:10:00.000Z'),
};

const vendorNotification = {
  _id: oid(),
  title: 'Pedido Paralizado en Depósito',
  message: 'Tu pedido quedó paralizado',
  targetRole: 'vendor',
  targetUserId: new mongoose.Types.ObjectId(USER_VENDOR),
  targetUsername: VENDOR_USERNAME,
  createdAt: new Date('2026-01-01T09:15:00.000Z'),
};
const legacyVendorNotification = {
  _id: oid(),
  title: 'Pedido Entregado',
  message: 'Tu pedido fue entregado',
  targetRole: 'vendor',
  targetUsername: VENDOR_USERNAME,
  createdAt: new Date('2026-01-01T09:20:00.000Z'),
};
const otherVendorNotification = {
  _id: oid(),
  title: 'Pedido de otro vendedor',
  message: 'No debe verse',
  targetRole: 'vendor',
  targetUserId: new mongoose.Types.ObjectId(USER_VENDOR_OTHER),
  targetUsername: OTHER_VENDOR_USERNAME,
  createdAt: new Date('2026-01-01T09:25:00.000Z'),
};
const globalForOtherVendorNotification = {
  _id: oid(),
  title: 'Global de otro vendedor',
  message: 'No debe verse',
  targetRole: 'all',
  targetUserId: new mongoose.Types.ObjectId(USER_VENDOR_OTHER),
  targetUsername: OTHER_VENDOR_USERNAME,
  createdAt: new Date('2026-01-01T09:30:00.000Z'),
};

const vendorNotifications = [
  vendorNotification,
  legacyVendorNotification,
  otherVendorNotification,
  globalForOtherVendorNotification,
];

const notifications = [depositNotification, billingNotification, globalNotification];

const users = new Map<string, { username?: string; role: string; notificationsEnabled: boolean }>([
  [USER_A, { role: 'controlador', notificationsEnabled: true }],
  [USER_B, { role: 'controlador', notificationsEnabled: true }],
  [USER_BILLING, { role: 'billing', notificationsEnabled: true }],
  [USER_ADMIN, { role: 'admin', notificationsEnabled: true }],
  [USER_LEGACY_DEPOSIT, { role: 'deposit', notificationsEnabled: true }],
  [USER_VENDOR, { username: VENDOR_USERNAME, role: 'vendedor', notificationsEnabled: true }],
  [
    USER_VENDOR_OTHER,
    { username: OTHER_VENDOR_USERNAME, role: 'vendedor', notificationsEnabled: true },
  ],
]);

const reads: any[] = [];
let updateCalls: any[] = [];
let aggregateCalls: any[][] = [];
let findQueries: any[] = [];

/** Evaluación mínima de la query de Mongo que usan los listados de prueba. */
const matchesValue = (value: any, condition: any): boolean => {
  if (condition instanceof mongoose.Types.ObjectId) {
    return String(value) === String(condition);
  }

  if (condition instanceof Date) {
    return new Date(value).getTime() === condition.getTime();
  }

  if (condition && typeof condition === 'object') {
    if (Array.isArray(condition.$in)) {
      return condition.$in.some((candidate: any) => matchesValue(value, candidate));
    }
    if ('$exists' in condition) {
      return (value !== undefined && value !== null) === Boolean(condition.$exists);
    }
    if ('$lt' in condition) {
      const target = condition.$lt;
      if (target instanceof Date) return new Date(value).getTime() < target.getTime();
      return String(value) < String(target);
    }
    if ('$eq' in condition) return matchesValue(value, condition.$eq);
  }

  return String(value) === String(condition);
};

const matchesQuery = (notification: any, query: any): boolean => {
  if (!query || typeof query !== 'object') return true;

  return Object.entries(query).every(([key, condition]) => {
    if (key === '$or') {
      return (condition as any[]).some((branch) => matchesQuery(notification, branch));
    }
    if (key === '$and') {
      return (condition as any[]).every((branch) => matchesQuery(notification, branch));
    }

    return matchesValue(notification[key], condition);
  });
};

const sortNotifications = (documents: any[]) =>
  [...documents].sort((a, b) => {
    const byCreatedAt = b.createdAt.getTime() - a.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return String(b._id).localeCompare(String(a._id));
  });

const stateFor = (userId: string, notificationId: unknown) =>
  reads.find(
    (read) =>
      String(read.userId) === String(userId) &&
      String(read.notificationId) === String(notificationId),
  );

const aggregateNotifications = (pipeline: any[]) => {
  const match = pipeline[0]?.$match ?? {};
  const stateUserId = String(
    pipeline.find((stage) => stage.$lookup)?.$lookup?.let?.stateUserId?.$literal ?? '',
  );

  let documents = sortNotifications(notifications.filter((n) => matchesQuery(n, match)));

  // El `$match` posterior al `$lookup` descarta las notificaciones con
  // dismissedAt para el usuario. Se aplica antes del `$limit`, igual que en
  // Mongo.
  if (pipeline.some((stage) => stage.$match?.$expr && stage.$match.$expr.$eq)) {
    documents = documents.filter(
      (notification) => !stateFor(stateUserId, notification._id)?.dismissedAt,
    );
  }

  const limit = pipeline.find((stage) => stage.$limit)?.$limit ?? documents.length;
  documents = documents.slice(0, limit);

  return documents.map((notification) => {
    const state = stateFor(stateUserId, notification._id);
    return {
      ...notification,
      read: Boolean(state?.readAt),
      readAt: state?.readAt ?? null,
    };
  });
};

let GET: (request: Request) => Promise<Response>;
let PUT: (request: Request) => Promise<Response>;

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(User as any, 'findById', (id: any) => {
    const value = users.get(String(id)) ?? null;
    const chain: any = {
      select: () => chain,
      lean: async () => value,
    };
    return chain;
  });

  mock.method(User as any, 'findByIdAndUpdate', (id: any, update: any, options: any) => {
    updateCalls.push({ id: String(id), update, options });
    const current = users.get(String(id));
    if (current) current.notificationsEnabled = update.notificationsEnabled;
    const chain: any = {
      select: () => chain,
      lean: async () => current ?? null,
    };
    return chain;
  });

  mock.method(Notification as any, 'aggregate', (pipeline: any[]) => {
    aggregateCalls.push(pipeline);
    return Promise.resolve(aggregateNotifications(pipeline));
  });

  mock.method(Notification as any, 'find', (query: any) => {
    findQueries.push(query);
    const chain: any = {
      select: () => chain,
      lean: async () => [],
    };
    return chain;
  });

  mock.method(Notification as any, 'countDocuments', (query: any) => {
    findQueries.push(query);
    return Promise.resolve(0);
  });

  ({ GET, PUT } = await import('../app/api/users/notifications/route'));
});

after(() => mock.restoreAll());

const reset = () => {
  reads.length = 0;
  updateCalls = [];
  aggregateCalls = [];
  findQueries = [];
};

const lastMatch = () => aggregateCalls[aggregateCalls.length - 1]?.[0]?.$match;

type TestRole = 'controlador' | 'billing' | 'admin' | 'vendedor';

const getNotifications = (userId: string, role: TestRole = 'controlador', query = '') =>
  GET(authRequest(`http://localhost/api/users/notifications${query}`, {}, role, userId));

const putPreference = (userId: string, body: unknown, role: TestRole = 'controlador') =>
  PUT(
    authRequest(
      'http://localhost/api/users/notifications',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      role,
      userId,
    ),
  );

test('NotificationRead declara timestamps y el único userId+notificationId', () => {
  const indexes = NotificationRead.schema.indexes();
  const unique = indexes.find(
    ([key, options]) =>
      (key as any).userId === 1 &&
      (key as any).notificationId === 1 &&
      (options as any)?.unique === true,
  );
  const byNotification = indexes.find(([key]) => (key as any).notificationId === 1);

  assert.ok(unique, 'debe existir el índice único { userId, notificationId }');
  assert.ok(byNotification, 'debe existir el índice para limpiar por notificationId');
  assert.equal((NotificationRead.schema as any).options.timestamps, true);
});

test('un usuario legacy deposit sigue usando la bandeja histórica deposit', async () => {
  reset();

  const response = await getNotifications(USER_LEGACY_DEPOSIT);
  const payload: any = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.inbox, 'deposit');
  assert.deepEqual(lastMatch(), { targetRole: { $in: ['deposit', 'all'] } });
});

test('GET usa la bandeja del rol, superpone el estado leído y oculta descartadas', async () => {
  reset();
  reads.push(
    {
      userId: USER_A,
      notificationId: depositNotification._id,
      readAt,
      dismissedAt: null,
    },
    {
      userId: USER_A,
      notificationId: globalNotification._id,
      readAt,
      dismissedAt,
    },
  );

  const response = await getNotifications(USER_A);
  const payload: any = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.inbox, 'deposit');
  assert.equal(payload.notificationsEnabled, true);
  assert.deepEqual(lastMatch(), { targetRole: { $in: ['deposit', 'all'] } });

  // Facturación no corresponde a la bandeja de depósito y la global está
  // descartada por este usuario: solo queda la de depósito, marcada leída.
  assert.deepEqual(
    payload.notifications.map((notification: any) => String(notification._id)),
    [String(depositNotification._id)],
  );
  assert.equal(payload.notifications[0].read, true);
  assert.equal(payload.notifications[0].readAt, readAt.toISOString());
  assert.equal(payload.pagination.mode, 'cursor');
  assert.equal(payload.pagination.hasMore, false);
  assert.equal(payload.pagination.nextCursor, null);
});

test('dos usuarios del mismo rol tienen estados de lectura independientes', async () => {
  reset();
  reads.push({
    userId: USER_A,
    notificationId: depositNotification._id,
    readAt,
    dismissedAt: null,
  });

  const userA = await getNotifications(USER_A);
  const userB = await getNotifications(USER_B);
  const payloadA: any = await userA.json();
  const payloadB: any = await userB.json();

  const stateForUser = (payload: any, id: any) =>
    payload.notifications.find((notification: any) => String(notification._id) === String(id));

  assert.equal(stateForUser(payloadA, depositNotification._id).read, true);
  assert.equal(stateForUser(payloadB, depositNotification._id).read, false);
});

test('facturación recibe su bandeja y admin puede listar todas con targetRole=all', async () => {
  reset();

  const billingResponse = await getNotifications(USER_BILLING, 'billing');
  const billingPayload: any = await billingResponse.json();
  assert.equal(billingPayload.inbox, 'billing');
  assert.deepEqual(lastMatch(), { targetRole: { $in: ['billing', 'all'] } });
  assert.deepEqual(
    billingPayload.notifications.map((notification: any) => notification.targetRole).sort(),
    ['all', 'billing'],
  );

  reset();
  const adminResponse = await getNotifications(USER_ADMIN, 'admin', '?targetRole=all');
  const adminPayload: any = await adminResponse.json();
  assert.equal(adminPayload.inbox, 'all');
  assert.deepEqual(lastMatch(), {});
  assert.equal(adminPayload.notifications.length, 3);
});

test('el vendedor solo ve su bandeja privada y nunca alertas de otros vendedores', async () => {
  reset();
  notifications.push(...vendorNotifications);

  try {
    const response = await getNotifications(USER_VENDOR, 'vendedor');
    const payload: any = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.inbox, 'vendor', 'la bandeja del vendedor se fuerza a vendor');
    assert.ok(Array.isArray(lastMatch().$or), 'el filtro debe ser el alcance privado por usuario');

    const ids = payload.notifications.map((notification: any) => String(notification._id));
    assert.ok(ids.includes(String(vendorNotification._id)), 've su alerta por userId');
    assert.ok(ids.includes(String(legacyVendorNotification._id)), 've el fallback por username');
    assert.ok(ids.includes(String(globalNotification._id)), 've la alerta global sin dueño');

    assert.ok(!ids.includes(String(otherVendorNotification._id)), 'no ve alertas de otro vendedor');
    assert.ok(
      !ids.includes(String(globalForOtherVendorNotification._id)),
      'no ve globales asignadas a otro vendedor',
    );
    assert.ok(!ids.includes(String(depositNotification._id)), 'no ve la bandeja de depósito');
    assert.ok(!ids.includes(String(billingNotification._id)), 'no ve la bandeja de facturación');
    assert.ok(
      payload.notifications.every(
        (notification: any) =>
          notification.targetRole === 'vendor' || notification.targetRole === 'all',
      ),
    );

    // Aunque el cliente pida otra bandeja, el servidor conserva la privada.
    reset();
    const forced = await getNotifications(USER_VENDOR, 'vendedor', '?targetRole=deposit');
    const forcedPayload: any = await forced.json();
    assert.equal(forcedPayload.inbox, 'vendor');
    assert.ok(Array.isArray(lastMatch().$or));
    assert.ok(
      forcedPayload.notifications.every(
        (notification: any) =>
          notification.targetRole === 'vendor' || notification.targetRole === 'all',
      ),
    );
  } finally {
    notifications.splice(
      notifications.length - vendorNotifications.length,
      vendorNotifications.length,
    );
  }
});

const assertVendorFilter = (query: any) => {
  assert.equal(query.targetRole, undefined, 'no debe filtrar por una bandeja compartida');
  assert.ok(Array.isArray(query.$or), 'debe usar ramas OR de alcance privado');

  const own = query.$or.find(
    (branch: any) => branch.targetRole === 'vendor' && String(branch.targetUserId) === USER_VENDOR,
  );
  const legacy = query.$or.find(
    (branch: any) =>
      branch.targetRole === 'vendor' &&
      branch.targetUserId?.$exists === false &&
      branch.targetUsername === VENDOR_USERNAME,
  );
  const global = query.$or.find(
    (branch: any) => branch.targetRole === 'all' && Array.isArray(branch.$and),
  );

  assert.ok(own, 'debe incluir las alertas dirigidas al userId');
  assert.ok(legacy, 'debe incluir el fallback por username');
  assert.ok(global, 'debe incluir las globales que no son de otro vendedor');
};

test('marcar todas y limpiar leídas respetan el alcance privado del vendedor', async () => {
  reset();
  await setAllNotificationsReadForUser({
    userId: USER_VENDOR,
    targetRole: 'deposit',
    role: 'vendedor',
    username: VENDOR_USERNAME,
    read: false,
  });
  assert.equal(findQueries.length, 1);
  assertVendorFilter(findQueries[0]);

  reset();
  await setAllNotificationsReadForUser({
    userId: USER_VENDOR,
    targetRole: 'billing',
    role: 'vendedor',
    username: VENDOR_USERNAME,
    read: true,
  });
  assert.equal(findQueries.length, 1);
  assertVendorFilter(findQueries[0]);

  reset();
  await dismissReadNotificationsForUser({
    userId: USER_VENDOR,
    targetRole: 'all',
    role: 'vendedor',
    username: VENDOR_USERNAME,
  });
  assert.equal(findQueries.length, 1);
  assertVendorFilter(findQueries[0]);
});

test('el cursor pagina sin repetir y el límite pide un documento extra para hasMore', async () => {
  reset();

  const extras = Array.from({ length: 25 }, (_, index) => {
    const createdAt = new Date(new Date('2025-12-31T12:00:00.000Z').getTime() - index * 60_000);
    return {
      _id: oid(),
      title: `Extra ${index}`,
      message: 'Notificación de paginación',
      targetRole: 'deposit',
      createdAt,
    };
  });
  notifications.push(...extras);

  try {
    const first = await getNotifications(USER_A, 'controlador', '?limit=10');
    const firstPayload: any = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstPayload.notifications.length, 10);
    assert.equal(firstPayload.pagination.limit, 10);
    assert.equal(firstPayload.pagination.hasMore, true);
    assert.equal(typeof firstPayload.pagination.nextCursor, 'string');
    assert.equal(aggregateCalls.at(-1)?.find((stage) => stage.$limit)?.$limit, 11);

    const second = await getNotifications(
      USER_A,
      'controlador',
      `?limit=10&cursor=${encodeURIComponent(firstPayload.pagination.nextCursor)}`,
    );
    const secondPayload: any = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondPayload.notifications.length, 10);

    const ids = [...firstPayload.notifications, ...secondPayload.notifications].map(
      (notification: any) => String(notification._id),
    );
    assert.equal(new Set(ids).size, ids.length, 'las páginas no deben repetir ids');

    const secondMatch = lastMatch();
    assert.ok(Array.isArray(secondMatch.$or), 'el cursor debe traducirse a un filtro $or');
  } finally {
    notifications.splice(notifications.length - extras.length, extras.length);
  }
});

test('las descartadas se filtran antes del límite y no tapan las no leídas', async () => {
  reset();

  // Las dos notificaciones más nuevas están descartadas solo para USER_A.
  const newest = sortNotifications(notifications).slice(0, 2);
  reads.push(
    ...newest.map((notification) => ({
      userId: USER_A,
      notificationId: notification._id,
      readAt,
      dismissedAt,
    })),
  );

  const response = await getNotifications(USER_A, 'controlador', '?limit=1');
  const payload: any = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.notifications.length, 1, 'la página no debe quedar vacía');
  assert.ok(
    !newest.some(
      (notification) => String(notification._id) === String(payload.notifications[0]._id),
    ),
    'la notificación devuelta no debe ser una descartada',
  );
});

test('GET rechaza un targetRole, cursor o límite inválidos antes de consultar Mongo', async () => {
  reset();

  const invalidRole = await getNotifications(USER_A, 'controlador', '?targetRole=otro');
  assert.equal(invalidRole.status, 400);
  assert.match((await invalidRole.json()).error, /Rol de notificación inválido/);

  const invalidCursor = await getNotifications(USER_A, 'controlador', '?cursor=no-es-un-cursor');
  assert.equal(invalidCursor.status, 400);
  assert.match((await invalidCursor.json()).error, /Cursor de paginación inválido/);

  const invalidLimit = await getNotifications(USER_A, 'controlador', '?limit=0');
  assert.equal(invalidLimit.status, 400);
  assert.equal(aggregateCalls.length, 0);
});

test('PUT actualiza notificationsEnabled solo del usuario de la sesión', async () => {
  reset();
  users.get(USER_A)!.notificationsEnabled = true;
  users.get(USER_B)!.notificationsEnabled = true;

  const response = await putPreference(USER_A, { notificationsEnabled: false });
  const payload: any = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.notificationsEnabled, false);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].id, USER_A);
  assert.deepEqual(updateCalls[0].update, { notificationsEnabled: false });
  assert.equal(users.get(USER_A)!.notificationsEnabled, false);
  assert.equal(users.get(USER_B)!.notificationsEnabled, true);

  const nextGet = await getNotifications(USER_A);
  const nextPayload: any = await nextGet.json();
  assert.equal(nextPayload.notificationsEnabled, false);

  users.get(USER_A)!.notificationsEnabled = true;
});

test('PUT valida el body y exige sesión', async () => {
  reset();

  const invalid = await putPreference(USER_A, { notificationsEnabled: 'si' });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /debe ser booleana/);
  assert.equal(updateCalls.length, 0);

  const anonymous = await PUT(
    new Request('http://localhost/api/users/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationsEnabled: false }),
    }),
  );
  assert.equal(anonymous.status, 401);

  const anonymousGet = await GET(new Request('http://localhost/api/users/notifications'));
  assert.equal(anonymousGet.status, 401);
});
