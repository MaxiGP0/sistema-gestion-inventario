/**
 * Pruebas de `/api/users/push-subscriptions`.
 *
 * Cubren el registro y la revocación de suscripciones Web Push sin base real:
 * - GET lista solo los dispositivos del usuario de la sesión y expone la
 *   clave pública VAPID (nunca la privada).
 * - POST registra/renueva el endpoint, ignora cualquier userId del body y
 *   reasigna una suscripción si otro usuario inicia sesión en el mismo equipo.
 * - Se limita la cantidad de dispositivos por usuario.
 * - DELETE por endpoint está acotado al usuario; `all=true` revoca solo los
 *   suyos.
 * - La validación Zod rechaza endpoints no HTTPS y claves faltantes.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mongoose from 'mongoose';

import { resetEnvCache } from '../lib/env';
import { toBrowserPushSubscriptionPayload } from '../lib/push-client';
import { PUSH_SUBSCRIPTION_MAX_PER_USER } from '../lib/push-subscriptions';
import { webPushSender } from '../lib/web-push';
import { PushSubscription } from '../models/PushSubscription';
import { authRequest } from './test-auth-utils';

const USER_A = '0000000000000000000000a1';
const USER_B = '0000000000000000000000b2';

process.env.VAPID_PUBLIC_KEY =
  'BJfjRf0IB-6KwI9OcCfyCuD44Gckk6maPLzWBhogU3xQ-lq1u8996lfThKoCTIOjj9gzTOYqm-BuE2az8ohvrpA';
process.env.VAPID_PRIVATE_KEY = 'gTwnjCzYxMWH4LCP7iRwthab9FL38tRpIyNlv8nel30';
process.env.VAPID_SUBJECT = 'mailto:test@example.com';
resetEnvCache();

const oid = () => new mongoose.Types.ObjectId();
const endpointFor = (suffix: string) => `https://push.example.com/${suffix}`;

interface FakeSubscription {
  _id: mongoose.Types.ObjectId;
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date;
}

let subscriptions: FakeSubscription[] = [];
let countCalls = 0;

const findChain = (documents: FakeSubscription[]) => {
  const chain: any = {
    select: () => chain,
    sort: () => chain,
    lean: async () => documents,
  };
  return chain;
};

const findOneChain = (document: FakeSubscription | null) => {
  const chain: any = {
    select: () => chain,
    lean: async () => document,
  };
  return chain;
};

let GET: (request: Request) => Promise<Response>;
let POST: (request: Request) => Promise<Response>;
let DELETE: (request: Request) => Promise<Response>;
let PATCH: (request: Request) => Promise<Response>;
let sendBehavior: (endpoint: string) => unknown = () => ({ statusCode: 201 });

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(PushSubscription as any, 'find', (filter: any) => {
    const documents = subscriptions.filter(
      (subscription) =>
        String(subscription.userId) === String(filter.userId) &&
        (!filter.endpoint || subscription.endpoint === filter.endpoint),
    );
    return findChain(documents);
  });

  mock.method(PushSubscription as any, 'updateOne', (filter: any, update: any) => {
    const doc = subscriptions.find((s) => String(s._id) === String(filter._id));
    if (doc && update.$set?.lastUsedAt) {
      doc.lastUsedAt = update.$set.lastUsedAt;
    }
    return Promise.resolve({ acknowledged: true, modifiedCount: doc ? 1 : 0 });
  });

  mock.method(webPushSender, 'send', async (target: any) => sendBehavior(target.endpoint));

  mock.method(PushSubscription as any, 'findOne', (filter: any) =>
    findOneChain(
      subscriptions.find((subscription) => subscription.endpoint === filter.endpoint) ?? null,
    ),
  );

  mock.method(PushSubscription as any, 'countDocuments', (filter: any) => {
    countCalls += 1;
    return subscriptions.filter((subscription) => subscription.userId === filter.userId).length;
  });

  mock.method(
    PushSubscription as any,
    'findOneAndUpdate',
    (filter: any, update: any, options: any = {}) => {
      let document = subscriptions.find(
        (subscription) => subscription.endpoint === filter.endpoint,
      );

      if (!document) {
        if (!options.upsert) return findOneChain(null);

        document = {
          _id: oid(),
          userId: String(update.$set.userId),
          endpoint: filter.endpoint,
          keys: update.$set.keys,
          userAgent: update.$set.userAgent,
          createdAt: update.$setOnInsert?.createdAt ?? new Date(),
          lastUsedAt: update.$set.lastUsedAt ?? new Date(),
        };
        subscriptions.push(document);
      } else {
        document.userId = String(update.$set.userId);
        document.keys = update.$set.keys;
        document.userAgent = update.$set.userAgent;
        document.lastUsedAt = update.$set.lastUsedAt ?? new Date();
      }

      return findOneChain(document);
    },
  );

  mock.method(PushSubscription as any, 'deleteOne', (filter: any) => {
    const before = subscriptions.length;
    subscriptions = subscriptions.filter((subscription) => {
      if (filter._id) return String(subscription._id) !== String(filter._id);
      return !(subscription.userId === filter.userId && subscription.endpoint === filter.endpoint);
    });
    return Promise.resolve({ deletedCount: before - subscriptions.length });
  });

  mock.method(PushSubscription as any, 'deleteMany', (filter: any) => {
    const before = subscriptions.length;
    subscriptions = subscriptions.filter((subscription) => subscription.userId !== filter.userId);
    return Promise.resolve({ deletedCount: before - subscriptions.length });
  });

  ({ GET, POST, DELETE, PATCH } = await import('../app/api/users/push-subscriptions/route'));
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
  countCalls = 0;
  sendBehavior = () => ({ statusCode: 201 });
};

const getSubscriptions = (userId: string = USER_A) =>
  GET(authRequest('http://localhost/api/users/push-subscriptions', {}, 'controlador', userId));

const register = (
  body: unknown,
  userId: string = USER_A,
  role: 'controlador' | 'billing' = 'controlador',
) =>
  POST(
    authRequest(
      'http://localhost/api/users/push-subscriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      role,
      userId,
    ),
  );

const revoke = (query: string, userId: string = USER_A) =>
  DELETE(
    authRequest(
      `http://localhost/api/users/push-subscriptions${query}`,
      { method: 'DELETE' },
      'controlador',
      userId,
    ),
  );

const validBody = (suffix: string) => ({
  endpoint: endpointFor(suffix),
  keys: { p256dh: `p256dh-${suffix}`, auth: `auth-${suffix}` },
  userAgent: 'Chrome de prueba',
});

test('PushSubscription declara el único por endpoint y el índice por userId', () => {
  const indexes = PushSubscription.schema.indexes();
  const uniqueEndpoint = indexes.find(
    ([key, options]) => (key as any).endpoint === 1 && (options as any)?.unique === true,
  );
  const byUser = indexes.find(
    ([key, options]) =>
      (key as any).userId === 1 &&
      (options as any)?.unique !== true &&
      !('endpoint' in (key as any)),
  );

  assert.ok(uniqueEndpoint, 'debe existir el índice único { endpoint: 1 }');
  assert.ok(byUser, 'debe existir el índice { userId: 1 }');
});

test('GET lista solo los dispositivos del usuario y expone la clave pública', async () => {
  reset();
  subscriptions.push(
    {
      _id: oid(),
      userId: USER_A,
      endpoint: endpointFor('a1'),
      keys: { p256dh: 'p1', auth: 'a1' },
      userAgent: 'Chrome',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastUsedAt: new Date('2026-01-02T00:00:00.000Z'),
    },
    {
      _id: oid(),
      userId: USER_B,
      endpoint: endpointFor('b1'),
      keys: { p256dh: 'p2', auth: 'a2' },
      userAgent: 'Firefox',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastUsedAt: new Date('2026-01-02T00:00:00.000Z'),
    },
  );

  const response = await getSubscriptions(USER_A);
  const payload: any = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.publicKey, process.env.VAPID_PUBLIC_KEY);
  assert.equal(payload.maxSubscriptions, PUSH_SUBSCRIPTION_MAX_PER_USER);
  assert.deepEqual(
    payload.subscriptions.map((subscription: any) => subscription.endpoint),
    [endpointFor('a1')],
  );
  assert.equal(payload.subscriptions[0].keys, undefined, 'las claves no deben exponerse');
});

test('POST registra el endpoint para el usuario de la sesión e ignora userId del body', async () => {
  reset();

  const body = { ...validBody('a1'), userId: USER_B };
  const response = await register(body);
  const payload: any = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].userId, USER_A);
  assert.equal(subscriptions[0].endpoint, endpointFor('a1'));
  assert.equal(subscriptions[0].keys.p256dh, 'p256dh-a1');
  assert.equal(payload.subscription.endpoint, endpointFor('a1'));
  assert.equal(payload.subscription.userId, undefined);
});

test('POST renueva el mismo endpoint sin duplicarlo y lo reasigna a otro usuario', async () => {
  reset();

  await register(validBody('shared'));
  await register(validBody('shared'), USER_B, 'billing');

  assert.equal(subscriptions.length, 1, 'el endpoint debe seguir siendo único');
  assert.equal(subscriptions[0].userId, USER_B);
  assert.equal(subscriptions[0].keys.p256dh, 'p256dh-shared');
});

test('POST respeta el límite de dispositivos por usuario', async () => {
  reset();

  for (let index = 0; index < PUSH_SUBSCRIPTION_MAX_PER_USER; index += 1) {
    const response = await register(validBody(`limit-${index}`));
    assert.equal(response.status, 200);
  }

  const rejected = await register(validBody('limit-extra'));
  const payload: any = await rejected.json();

  assert.equal(rejected.status, 409);
  assert.match(payload.error, /límite/i);
  assert.equal(subscriptions.length, PUSH_SUBSCRIPTION_MAX_PER_USER);

  // Renovar un endpoint ya registrado no cuenta como un dispositivo nuevo.
  countCalls = 0;
  const renewed = await register(validBody('limit-0'));
  assert.equal(renewed.status, 200);
  assert.equal(countCalls, 0);
});

test('DELETE por endpoint está acotado al usuario de la sesión', async () => {
  reset();
  await register(validBody('own'), USER_A);
  await register(validBody('other'), USER_B, 'billing');

  const foreign = await revoke(`?endpoint=${encodeURIComponent(endpointFor('other'))}`, USER_A);
  const foreignPayload: any = await foreign.json();

  assert.equal(foreign.status, 200);
  assert.equal(foreignPayload.removed, 0);
  assert.equal(subscriptions.length, 2, 'no debe borrar la suscripción de otro usuario');

  const own = await revoke(`?endpoint=${encodeURIComponent(endpointFor('own'))}`, USER_A);
  const ownPayload: any = await own.json();

  assert.equal(own.status, 200);
  assert.equal(ownPayload.removed, 1);
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].userId, USER_B);
});

test('DELETE all=true revoca solo los dispositivos del usuario', async () => {
  reset();
  await register(validBody('a1'), USER_A);
  await register(validBody('a2'), USER_A);
  await register(validBody('b1'), USER_B, 'billing');

  const response = await revoke('?all=true', USER_A);
  const payload: any = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.removed, 2);
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].userId, USER_B);
});

test('DELETE acepta el endpoint en el body JSON', async () => {
  reset();
  await register(validBody('body-delete'), USER_A);

  const response = await DELETE(
    authRequest(
      'http://localhost/api/users/push-subscriptions',
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: endpointFor('body-delete') }),
      },
      'controlador',
      USER_A,
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(subscriptions.length, 0);
});

test('POST y DELETE validan el body y exigen sesión', async () => {
  reset();

  const httpEndpoint = await register({
    endpoint: 'http://push.example.com/insecure',
    keys: { p256dh: 'p', auth: 'a' },
  });
  assert.equal(httpEndpoint.status, 400);
  assert.match((await httpEndpoint.json()).error, /HTTPS/);

  const missingKeys = await register({ endpoint: endpointFor('no-keys') });
  assert.equal(missingKeys.status, 400);

  const emptyDelete = await DELETE(
    authRequest(
      'http://localhost/api/users/push-subscriptions',
      { method: 'DELETE' },
      'controlador',
      USER_A,
    ),
  );
  assert.equal(emptyDelete.status, 400);
  assert.equal(subscriptions.length, 0);

  const anonymous = await POST(
    new Request('http://localhost/api/users/push-subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody('anonymous')),
    }),
  );
  assert.equal(anonymous.status, 401);

  const anonymousGet = await GET(new Request('http://localhost/api/users/push-subscriptions'));
  assert.equal(anonymousGet.status, 401);
});

test('si VAPID no está configurado, POST responde 503 y GET publica publicKey null', async () => {
  reset();

  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  resetEnvCache();

  try {
    const response = await register(validBody('no-vapid'));
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /no está configurado/i);

    const list = await getSubscriptions(USER_A);
    const payload: any = await list.json();
    assert.equal(list.status, 200);
    assert.equal(payload.publicKey, null);
  } finally {
    process.env.VAPID_PUBLIC_KEY =
      'BJfjRf0IB-6KwI9OcCfyCuD44Gckk6maPLzWBhogU3xQ-lq1u8996lfThKoCTIOjj9gzTOYqm-BuE2az8ohvrpA';
    process.env.VAPID_PRIVATE_KEY = 'gTwnjCzYxMWH4LCP7iRwthab9FL38tRpIyNlv8nel30';
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
    resetEnvCache();
  }
});

test('POST normaliza claves p256dh/auth en base64 estándar o con padding a base64url', async () => {
  reset();

  const response = await register({
    endpoint: endpointFor('firefox-b64'),
    keys: {
      p256dh: 'ab+cd/ef==',
      auth: '12+34/56=',
    },
    userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
  });

  assert.equal(response.status, 200);
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].keys.p256dh, 'ab-cd_ef');
  assert.equal(subscriptions[0].keys.auth, '12-34_56');
});

test('toBrowserPushSubscriptionPayload usa getKey() como respaldo cuando toJSON().keys falta', () => {
  const p256dhBytes = new Uint8Array([1, 2, 3, 250, 251, 255]);
  const authBytes = new Uint8Array([10, 20, 30, 40]);

  const fakeSub = {
    endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/token',
    toJSON: () => ({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/token' }),
    getKey: (name: string) => {
      if (name === 'p256dh') return p256dhBytes.buffer;
      if (name === 'auth') return authBytes.buffer;
      return null;
    },
  } as unknown as globalThis.PushSubscription;

  const payload = toBrowserPushSubscriptionPayload(fakeSub);
  assert.equal(payload.endpoint, 'https://updates.push.services.mozilla.com/wpush/v2/token');
  assert.doesNotMatch(payload.keys.p256dh, /[+/=]/);
  assert.doesNotMatch(payload.keys.auth, /[+/=]/);
});

test('PATCH envía una notificación de prueba y limpia suscripciones vencidas (410)', async () => {
  reset();
  await register(validBody('test-device'), USER_A);

  const okResponse = await PATCH(
    authRequest(
      'http://localhost/api/users/push-subscriptions',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: endpointFor('test-device') }),
      },
      'controlador',
      USER_A,
    ),
  );
  const okPayload: any = await okResponse.json();
  assert.equal(okResponse.status, 200);
  assert.equal(okPayload.sent, 1);
  assert.equal(okPayload.removed, 0);

  // Si el servicio push devuelve 410 Gone, se elimina la suscripción y responde 410.
  sendBehavior = () => {
    throw Object.assign(new Error('Gone'), { statusCode: 410 });
  };

  const goneResponse = await PATCH(
    authRequest(
      'http://localhost/api/users/push-subscriptions',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: endpointFor('test-device') }),
      },
      'controlador',
      USER_A,
    ),
  );
  assert.equal(goneResponse.status, 410);
  assert.equal(subscriptions.length, 0);
});
