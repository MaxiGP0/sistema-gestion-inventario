/**
 * Pruebas del dispatcher de Web Push.
 *
 * Sin base real ni servidor push: se stubean User.find, PushSubscription y el
 * envío de web-push. Cubren:
 * - filtro por rol destinatario y preferencia `notificationsEnabled`;
 * - payload JSON con título, mensaje, targetRole y deep link;
 * - limpieza de suscripciones vencidas (404/410) y tolerancia a otros errores;
 * - error de base o VAPID ausente sin propagar la excepción.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { resetEnvCache } from '../lib/env';
import {
  dispatchPushNotification,
  findPushRecipients,
  pushRecipientRoles,
} from '../lib/push-notifications';
import { isExpiredPushSubscriptionError } from '../lib/push-subscriptions';
import { webPushSender } from '../lib/web-push';
import { PushSubscription } from '../models/PushSubscription';
import { User } from '../models/User';

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-auth-secret-sgi-0123456789';
process.env.VAPID_PUBLIC_KEY =
  'BJfjRf0IB-6KwI9OcCfyCuD44Gckk6maPLzWBhogU3xQ-lq1u8996lfThKoCTIOjj9gzTOYqm-BuE2az8ohvrpA';
process.env.VAPID_PRIVATE_KEY = 'gTwnjCzYxMWH4LCP7iRwthab9FL38tRpIyNlv8nel30';
process.env.VAPID_SUBJECT = 'mailto:test@example.com';
resetEnvCache();

const oid = () => new mongoose.Types.ObjectId();
const ORDER_ID = '64b7f1c2e4b0a1d2f3a4b5c6';

interface FakeUser {
  _id: mongoose.Types.ObjectId;
  role: string;
  username: string;
  active: boolean;
  notificationsEnabled: boolean;
}

interface FakeSubscription {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const CONTROLADOR = '0000000000000000000000a1';
const CONTROLADOR_DISABLED = '0000000000000000000000a2';
const BILLING = '0000000000000000000000b1';
const VENDEDOR = '0000000000000000000000c1';
const VENDEDOR_OTHER = '0000000000000000000000c2';
const LEGACY_DEPOSIT = '0000000000000000000000d1';
const ADMIN = '0000000000000000000000e1';

const users: FakeUser[] = [
  {
    _id: new mongoose.Types.ObjectId(CONTROLADOR),
    role: 'controlador',
    username: 'deposito-1',
    active: true,
    notificationsEnabled: true,
  },
  {
    _id: new mongoose.Types.ObjectId(CONTROLADOR_DISABLED),
    role: 'controlador',
    username: 'deposito-2',
    active: true,
    notificationsEnabled: false,
  },
  {
    _id: new mongoose.Types.ObjectId(BILLING),
    role: 'billing',
    username: 'facturacion',
    active: true,
    notificationsEnabled: true,
  },
  {
    _id: new mongoose.Types.ObjectId(VENDEDOR),
    role: 'vendedor',
    username: 'vendedor',
    active: true,
    notificationsEnabled: true,
  },
  {
    _id: new mongoose.Types.ObjectId(VENDEDOR_OTHER),
    role: 'vendedor',
    username: 'vendedor-otro',
    active: true,
    notificationsEnabled: true,
  },
  {
    _id: new mongoose.Types.ObjectId(LEGACY_DEPOSIT),
    role: 'deposit',
    username: 'deposito-legacy',
    active: true,
    notificationsEnabled: true,
  },
  {
    _id: new mongoose.Types.ObjectId(ADMIN),
    role: 'admin',
    username: 'admin',
    active: true,
    notificationsEnabled: true,
  },
];

let subscriptions: FakeSubscription[] = [];
let sendCalls: Array<{ endpoint: string; payload: any; options: any }> = [];
let updatedSubscriptions: unknown[] = [];
let deletedSubscriptions: unknown[] = [];
let loggedErrors: unknown[][] = [];

let sendBehavior: (callIndex: number) => unknown = () => ({ statusCode: 201 });
let userFindShouldThrow = false;

const chain = (value: unknown) => {
  const result: any = {
    select: () => result,
    sort: () => result,
    lean: async () => value,
  };
  return result;
};

before(() => {
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(User as any, 'find', (filter: any) => {
    if (userFindShouldThrow) throw new Error('Mongo caído');

    const eligible = users.filter(
      (user) =>
        user.active !== false &&
        user.notificationsEnabled !== false &&
        filter?.notificationsEnabled?.$ne === false,
    );
    return chain(eligible);
  });

  mock.method(PushSubscription as any, 'find', (filter: any) => {
    const ids = (filter.userId?.$in ?? []).map(String);
    return chain(subscriptions.filter((subscription) => ids.includes(String(subscription.userId))));
  });

  mock.method(PushSubscription as any, 'updateOne', (filter: any, update: any) => {
    updatedSubscriptions.push({ id: String(filter._id), update });
    return Promise.resolve({ acknowledged: true, modifiedCount: 1 });
  });

  mock.method(PushSubscription as any, 'deleteOne', (filter: any) => {
    deletedSubscriptions.push(String(filter._id));
    subscriptions = subscriptions.filter(
      (subscription) => String(subscription._id) !== String(filter._id),
    );
    return Promise.resolve({ deletedCount: 1 });
  });

  mock.method(webPushSender, 'send', async (target: any, payload: string, options: any) => {
    sendCalls.push({ endpoint: target.endpoint, payload: JSON.parse(payload), options });
    return sendBehavior(sendCalls.length - 1);
  });

  mock.method(console, 'error', (...args: unknown[]) => {
    loggedErrors.push(args);
  });
});

after(() => {
  mock.restoreAll();
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  resetEnvCache();
});

const reset = () => {
  subscriptions = [];
  sendCalls = [];
  updatedSubscriptions = [];
  deletedSubscriptions = [];
  loggedErrors = [];
  sendBehavior = () => ({ statusCode: 201 });
  userFindShouldThrow = false;
};

const addSubscription = (userId: string, suffix: string) => {
  subscriptions.push({
    _id: oid(),
    userId: new mongoose.Types.ObjectId(userId),
    endpoint: `https://push.example.com/${suffix}`,
    keys: { p256dh: `p-${suffix}`, auth: `a-${suffix}` },
  });
};

test('pushRecipientRoles usa el rol destinatario, admin y all para la alerta global', () => {
  assert.deepEqual(pushRecipientRoles('deposit'), ['admin', 'controlador']);
  assert.deepEqual(pushRecipientRoles('billing'), ['admin', 'billing']);
  assert.deepEqual(pushRecipientRoles('vendor'), ['admin', 'vendedor']);
  assert.deepEqual(pushRecipientRoles('all'), ['admin', 'vendedor', 'controlador', 'billing']);
});

test('findPushRecipients excluye otros roles y acota las alertas de vendedor al destinatario', async () => {
  const depositRecipients = await findPushRecipients('deposit');
  const billingRecipients = await findPushRecipients('billing');
  const vendorRecipients = await findPushRecipients('vendor', { targetUserId: VENDEDOR });
  const legacyVendorRecipients = await findPushRecipients('vendor', {
    targetUsername: 'vendedor-otro',
  });
  const allRecipients = await findPushRecipients('all');

  assert.deepEqual(
    depositRecipients.map((recipient) => recipient.userId).sort(),
    [ADMIN, CONTROLADOR, LEGACY_DEPOSIT].sort(),
    'deposit incluye admin, controlador y el rol legacy, no vendedor ni facturación',
  );
  assert.deepEqual(
    billingRecipients.map((recipient) => recipient.userId).sort(),
    [ADMIN, BILLING].sort(),
  );
  assert.deepEqual(
    vendorRecipients.map((recipient) => recipient.userId).sort(),
    [ADMIN, VENDEDOR].sort(),
    'vendor solo incluye al vendedor destinatario y a admin',
  );
  assert.deepEqual(
    legacyVendorRecipients.map((recipient) => recipient.userId).sort(),
    [ADMIN, VENDEDOR_OTHER].sort(),
    'sin userId, el username identifica al vendedor histórico',
  );
  assert.deepEqual(
    allRecipients.map((recipient) => recipient.userId).sort(),
    [ADMIN, BILLING, CONTROLADOR, LEGACY_DEPOSIT, VENDEDOR, VENDEDOR_OTHER].sort(),
    'all incluye todos los roles activos con preferencia activa',
  );
});

test('el push de depósito llega a controladores y admin con preferencia activa y usa el detalle', async () => {
  reset();
  addSubscription(CONTROLADOR, 'controlador');
  addSubscription(CONTROLADOR_DISABLED, 'controlador-disabled');
  addSubscription(BILLING, 'billing');

  const result = await dispatchPushNotification({
    title: 'Nuevo pedido',
    message: 'Pedido #123 listo para picking',
    targetRole: 'deposit',
    orderId: ORDER_ID,
  });

  assert.equal(result.recipients, 3);
  assert.equal(result.sent, 1);
  assert.equal(result.removed, 0);
  assert.equal(sendCalls.length, 1, 'solo el controlador habilitado debe recibir push');
  assert.equal(sendCalls[0].endpoint, 'https://push.example.com/controlador');
  assert.deepEqual(sendCalls[0].payload, {
    title: 'Nuevo pedido',
    body: 'Pedido #123 listo para picking',
    targetRole: 'deposit',
    orderId: ORDER_ID,
    url: `/deposit/orders/${ORDER_ID}`,
  });
  assert.equal(sendCalls[0].options.TTL > 0, true);
  assert.equal(sendCalls[0].options.urgency, 'high');
  assert.equal(updatedSubscriptions.length, 1, 'lastUsedAt debe actualizarse al enviar');
});

test('facturación recibe la bandeja y el detalle correcto', async () => {
  reset();
  addSubscription(BILLING, 'billing');

  await dispatchPushNotification({
    title: 'Pedido verificado',
    message: 'Listo para facturar',
    targetRole: 'billing',
    orderId: ORDER_ID,
  });

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].payload.url, `/billing/orders/${ORDER_ID}`);
  assert.equal(sendCalls[0].payload.targetRole, 'billing');
});

test('el push de vendedor solo llega a su suscripción y a admin, con el detalle /orders/:id', async () => {
  reset();
  addSubscription(VENDEDOR, 'vendedor');
  addSubscription(VENDEDOR_OTHER, 'vendedor-otro');
  addSubscription(ADMIN, 'admin');
  addSubscription(CONTROLADOR, 'controlador');

  const result = await dispatchPushNotification({
    title: 'Pedido Paralizado en Depósito',
    message: 'Tu pedido quedó paralizado',
    targetRole: 'vendor',
    targetUserId: VENDEDOR,
    targetUsername: 'vendedor',
    orderId: ORDER_ID,
  });

  assert.equal(result.recipients, 2, 'solo el vendedor destinatario y admin');
  assert.equal(result.sent, 2);
  assert.deepEqual(sendCalls.map((call) => call.endpoint).sort(), [
    'https://push.example.com/admin',
    'https://push.example.com/vendedor',
  ]);
  const sellerPush = sendCalls.find(
    (call) => call.endpoint === 'https://push.example.com/vendedor',
  );
  assert.ok(sellerPush);
  assert.deepEqual(sellerPush.payload, {
    title: 'Pedido Paralizado en Depósito',
    body: 'Tu pedido quedó paralizado',
    targetRole: 'vendor',
    orderId: ORDER_ID,
    url: `/orders/${ORDER_ID}`,
  });
});

test('sin orderId el push de vendedor abre su bandeja /orders', async () => {
  reset();
  addSubscription(VENDEDOR, 'vendedor');

  await dispatchPushNotification({
    title: 'Pedido Entregado',
    message: 'Tu pedido fue entregado',
    targetRole: 'vendor',
    targetUserId: VENDEDOR,
  });

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].payload.url, '/orders');
});

test('sin orderId el deep link abre la bandeja; all abre el panel', async () => {
  reset();
  addSubscription(CONTROLADOR, 'controlador');
  addSubscription(BILLING, 'billing');
  addSubscription(VENDEDOR, 'vendedor');

  await dispatchPushNotification({
    title: 'Aviso de depósito',
    message: 'Sin pedido',
    targetRole: 'deposit',
  });
  await dispatchPushNotification({
    title: 'Aviso de facturación',
    message: 'Sin pedido',
    targetRole: 'billing',
  });
  await dispatchPushNotification({
    title: 'Aviso global',
    message: 'Para todos',
    targetRole: 'all',
    orderId: ORDER_ID,
  });

  assert.equal(sendCalls[0].payload.url, '/deposit/orders');
  assert.equal(sendCalls[1].payload.url, '/billing/orders');
  assert.equal(sendCalls[2].payload.url, '/', 'all no elige una bandeja ambigua');
});

test('una suscripción 410 o 404 se borra; un 5xx solo se registra', async () => {
  reset();
  addSubscription(CONTROLADOR, 'gone');
  addSubscription(CONTROLADOR, 'expired');
  addSubscription(CONTROLADOR, 'server-error');

  const gone = Object.assign(new Error('Gone'), { statusCode: 410 });
  const expired = Object.assign(new Error('Not found'), { statusCode: 404 });
  const serverError = Object.assign(new Error('Push service down'), { statusCode: 500 });

  sendBehavior = (call) => {
    if (call === 0) throw gone;
    if (call === 1) throw expired;
    throw serverError;
  };

  const result = await dispatchPushNotification({
    title: 'Nuevo pedido',
    message: 'Prueba de limpieza',
    targetRole: 'deposit',
    orderId: ORDER_ID,
  });

  assert.equal(result.sent, 0);
  assert.equal(result.removed, 2, '404 y 410 deben borrar la fila');
  assert.equal(deletedSubscriptions.length, 2);
  assert.equal(subscriptions.length, 1, 'el error 5xx conserva la suscripción');
  assert.ok(
    loggedErrors.some((args) => args.some((arg) => String(arg).includes('Push service down'))),
    'el error 5xx debe quedar en el log',
  );
});

test('isExpiredPushSubscriptionError reconoce solo 404 y 410', () => {
  assert.equal(isExpiredPushSubscriptionError({ statusCode: 404 }), true);
  assert.equal(isExpiredPushSubscriptionError({ statusCode: 410 }), true);
  assert.equal(isExpiredPushSubscriptionError({ statusCode: 500 }), false);
  assert.equal(isExpiredPushSubscriptionError(null), false);
});

test('sin VAPID configurado el dispatcher no envía y no lanza', async () => {
  reset();

  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  resetEnvCache();

  try {
    const result = await dispatchPushNotification({
      title: 'Nuevo pedido',
      message: 'Sin VAPID',
      targetRole: 'deposit',
      orderId: ORDER_ID,
    });

    assert.equal(result.skipped, 'not-configured');
    assert.equal(sendCalls.length, 0);
  } finally {
    process.env.VAPID_PUBLIC_KEY =
      'BJfjRf0IB-6KwI9OcCfyCuD44Gckk6maPLzWBhogU3xQ-lq1u8996lfThKoCTIOjj9gzTOYqm-BuE2az8ohvrpA';
    process.env.VAPID_PRIVATE_KEY = 'gTwnjCzYxMWH4LCP7iRwthab9FL38tRpIyNlv8nel30';
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
    resetEnvCache();
  }
});

test('un fallo de la base en el dispatcher queda en el log y no propaga', async () => {
  reset();
  userFindShouldThrow = true;

  await assert.doesNotReject(
    dispatchPushNotification({
      title: 'Nuevo pedido',
      message: 'Base caída',
      targetRole: 'deposit',
    }),
  );

  assert.ok(
    loggedErrors.some((args) => args.some((arg) => String(arg).includes('dispatcher de Web Push'))),
  );
});
