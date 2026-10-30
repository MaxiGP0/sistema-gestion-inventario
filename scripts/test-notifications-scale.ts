/**
 * Pruebas de escala de notificaciones (10.000 documentos).
 *
 * Usa MongoDB en memoria porque las garantías dependen del motor real:
 * - paginación por cursor `createdAt/_id` sin repetir ni saltear documentos;
 * - descartadas filtradas antes del `$limit` (no tapan no leídas);
 * - "marcar todas" con un `$merge` masivo y ventana acotada, sin cargar ids;
 * - limpieza de `NotificationRead` huérfanos por lotes;
 * - índice TTL de retención de 180 días.
 *
 * Además mide la latencia del listado y de "marcar todas" contra una
 * implementación de referencia "antes" (filtrar después del límite y hacer un
 * upsert por id), y deja el resultado en la salida del test.
 *
 * Ejecutar con: npm test (o npm run test:notifications:scale).
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { NOTIFICATION_RETENTION_SECONDS, Notification } from '../models/Notification';
import { NotificationRead } from '../models/NotificationRead';
import {
  NOTIFICATION_MARK_ALL_WINDOW_DAYS,
  listNotificationsForUser,
  notificationRoleQuery,
  setAllNotificationsReadForUser,
} from '../lib/notifications';
import { decodeNotificationCursor, type NotificationCursor } from '../lib/notification-cursor';
import {
  cleanupOrphanNotificationReads,
  type NotificationReadCleanupProgress,
} from '../lib/notification-retention';

const NOTIFICATION_COUNT = 10_000;
const SEED_CHUNK_SIZE = 2_000;

const USER_PAGINATION = new mongoose.Types.ObjectId();
const USER_DISMISSED = new mongoose.Types.ObjectId();
const USER_MARK_ALL = new mongoose.Types.ObjectId();
const USER_MARK_ALL_BASELINE = new mongoose.Types.ObjectId();

const baseDate = new Date();
// 20 minutos entre documentos: 10.000 cubren ~139 días (dentro de los 180 de
// retención y cruzando la ventana de 90 días de "marcar todas").
const dateForIndex = (index: number) => new Date(baseDate.getTime() - index * 20 * 60 * 1000);

let mongo: MongoMemoryServer;

const elapsed = async <T>(operation: () => Promise<T>): Promise<{ result: T; ms: number }> => {
  const startedAt = performance.now();
  const result = await operation();
  return { result, ms: performance.now() - startedAt };
};

const logMetric = (label: string, value: unknown) => {
  console.log(`[notifications-scale] ${label}: ${JSON.stringify(value)}`);
};

async function seedNotifications() {
  const roles = ['deposit', 'billing', 'all'] as const;
  let inserted = 0;

  while (inserted < NOTIFICATION_COUNT) {
    const chunk = Array.from(
      { length: Math.min(SEED_CHUNK_SIZE, NOTIFICATION_COUNT - inserted) },
      (_, offset) => {
        const index = inserted + offset;
        return {
          _id: new mongoose.Types.ObjectId(),
          title: `Notificación ${index}`,
          message: `Mensaje de escala ${index}`,
          targetRole: roles[index % roles.length],
          createdAt: dateForIndex(index),
        };
      },
    );
    await Notification.collection.insertMany(chunk, { ordered: false });
    inserted += chunk.length;
  }
}

async function rawRoleNotifications(targetRole: 'deposit' | 'billing' | 'all', limit: number) {
  return Notification.find(notificationRoleQuery(targetRole))
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .select('_id createdAt')
    .lean();
}

before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { dbName: 'sgi-notifications-scale' } });
  await mongoose.connect(mongo.getUri('sgi-notifications-scale'));
  (globalThis as { mongoose?: unknown }).mongoose = { conn: mongoose, promise: null };

  await Notification.createIndexes();
  await NotificationRead.createIndexes();
  await Notification.collection.deleteMany({});
  await NotificationRead.collection.deleteMany({});
  await seedNotifications();
});

after(async () => {
  await Notification.collection.deleteMany({});
  await NotificationRead.collection.deleteMany({});
  await mongoose.disconnect();
  await mongo.stop();
});

test('10k notificaciones: el cursor pagina sin repetir ni saltear', async () => {
  const pageSize = 50;
  const pagesToRead = 5;
  const seen = new Set<string>();
  let cursor: NotificationCursor | null = null;
  let previous: { createdAt: Date; _id: unknown } | null = null;

  for (let page = 0; page < pagesToRead; page += 1) {
    const { result: current } = await elapsed(() =>
      listNotificationsForUser({
        userId: USER_PAGINATION,
        targetRole: 'all',
        limit: pageSize,
        cursor,
      }),
    );

    assert.equal(current.notifications.length, pageSize);
    assert.equal(current.hasMore, true);
    assert.ok(current.nextCursor);

    for (const notification of current.notifications) {
      const id = String(notification._id);
      assert.ok(!seen.has(id), `el id ${id} se repitió entre páginas`);
      seen.add(id);

      const createdAt = new Date(notification.createdAt as string | Date);
      if (previous) {
        const order =
          createdAt.getTime() - previous.createdAt.getTime() ||
          String(previous._id).localeCompare(String(notification._id));
        assert.ok(order <= 0, 'las páginas deben mantener el orden createdAt/_id descendente');
      }
      previous = { createdAt, _id: notification._id };
    }

    cursor = decodeNotificationCursor(current.nextCursor!);
    assert.ok(cursor, 'el nextCursor debe ser decodificable');
  }

  assert.equal(seen.size, pageSize * pagesToRead);
});

test('las descartadas se excluyen antes del límite y no tapan no leídas', async () => {
  const dismissedCount = 60;
  const pageSize = 30;
  const raw = await rawRoleNotifications('deposit', dismissedCount);
  assert.equal(raw.length, dismissedCount);

  const now = new Date();
  await NotificationRead.insertMany(
    raw.map((notification) => ({
      userId: USER_DISMISSED,
      notificationId: notification._id,
      readAt: now,
      dismissedAt: now,
    })),
    { ordered: false },
  );

  // Implementación "antes": limitar primero y filtrar las descartadas después.
  const { result: beforeResult, ms: beforeMs } = await elapsed(async () => {
    const notifications = await Notification.find(notificationRoleQuery('deposit'))
      .sort({ createdAt: -1, _id: -1 })
      .limit(pageSize)
      .lean();
    const states = await NotificationRead.find({
      userId: USER_DISMISSED,
      notificationId: { $in: notifications.map((notification) => notification._id) },
    }).lean();
    const dismissed = new Set(
      states.filter((state) => state.dismissedAt).map((state) => String(state.notificationId)),
    );
    return notifications.filter((notification) => !dismissed.has(String(notification._id)));
  });

  const { result: afterResult, ms: afterMs } = await elapsed(() =>
    listNotificationsForUser({
      userId: USER_DISMISSED,
      targetRole: 'deposit',
      limit: pageSize,
    }),
  );

  logMetric('listado con 60 descartadas al frente', {
    before: { visible: beforeResult.length, ms: Number(beforeMs.toFixed(2)) },
    after: { visible: afterResult.notifications.length, ms: Number(afterMs.toFixed(2)) },
  });

  assert.equal(beforeResult.length, 0, 'el algoritmo viejo deja la página vacía');
  assert.equal(afterResult.notifications.length, pageSize, 'el nuevo debe completar la página');
  assert.equal(afterResult.hasMore, true);

  const dismissedIds = new Set(raw.map((notification) => String(notification._id)));
  assert.ok(
    afterResult.notifications.every((notification) => !dismissedIds.has(String(notification._id))),
    'no debe devolver descartadas',
  );

  // La primera visible debe ser la notificación inmediatamente posterior a las
  // 60 descartadas.
  const expectedFirst = await rawRoleNotifications('deposit', dismissedCount + 1);
  assert.equal(String(afterResult.notifications[0]._id), String(expectedFirst[dismissedCount]._id));
});

test('el cursor desempata por _id cuando hay createdAt repetidos', async () => {
  const tieDate = new Date(baseDate.getTime() + 60_000);
  const tieDocuments = Array.from({ length: 5 }, (_, index) => ({
    _id: new mongoose.Types.ObjectId(),
    title: `Empate ${index}`,
    message: 'Mismo createdAt',
    targetRole: 'billing' as const,
    createdAt: tieDate,
  }));
  await Notification.collection.insertMany(tieDocuments);

  try {
    const first = await listNotificationsForUser({
      userId: USER_PAGINATION,
      targetRole: 'billing',
      limit: 2,
    });
    const firstIds = first.notifications.map((notification) => String(notification._id));
    assert.equal(firstIds.length, 2);
    assert.equal(first.hasMore, true);

    const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
    const second = await listNotificationsForUser({
      userId: USER_PAGINATION,
      targetRole: 'billing',
      limit: 3,
      cursor: {
        createdAt: new Date(decoded.createdAt),
        id: new mongoose.Types.ObjectId(decoded.id),
      },
    });

    const allIds = [...firstIds, ...second.notifications.map((n) => String(n._id))];
    assert.equal(new Set(allIds).size, allIds.length, 'no debe repetir documentos empatados');

    const expected = [...tieDocuments]
      .sort((a, b) => String(b._id).localeCompare(String(a._id)))
      .map((document) => String(document._id));
    assert.deepEqual(allIds.slice(0, 5), expected, 'el desempate debe ser _id descendente');
  } finally {
    await Notification.collection.deleteMany({ _id: { $in: tieDocuments.map((d) => d._id) } });
  }
});

test('marcar todas usa un $merge acotado y no carga ids en el proceso', async () => {
  const cutoff = new Date(Date.now() - NOTIFICATION_MARK_ALL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const expected = await Notification.countDocuments({
    ...notificationRoleQuery('deposit'),
    createdAt: { $gte: cutoff },
  });
  assert.ok(expected > 0);

  // Una fila ya descartada dentro de la ventana: el $merge debe actualizar
  // readAt sin resucitarla (preservar dismissedAt).
  const dismissedTarget = await Notification.findOne({
    ...notificationRoleQuery('deposit'),
    createdAt: { $gte: cutoff },
  })
    .select('_id')
    .lean();
  assert.ok(dismissedTarget);
  const dismissedAt = new Date();
  await NotificationRead.create({
    userId: USER_MARK_ALL,
    notificationId: dismissedTarget._id,
    readAt: new Date('2026-01-01T00:00:00.000Z'),
    dismissedAt,
  });

  const { result: marked, ms: afterMs } = await elapsed(() =>
    setAllNotificationsReadForUser({
      userId: USER_MARK_ALL,
      targetRole: 'deposit',
      read: true,
    }),
  );
  assert.equal(marked, expected);
  assert.equal(
    await NotificationRead.countDocuments({ userId: USER_MARK_ALL }),
    expected,
    'debe crear una fila por notificación de la ventana',
  );

  const preserved = await NotificationRead.findOne({
    userId: USER_MARK_ALL,
    notificationId: dismissedTarget._id,
  }).lean();
  assert.ok(preserved?.dismissedAt, 'marcar todas no debe revivir una descartada');

  // Implementación "antes": traer todos los ids y hacer un upsert por cada uno.
  const { result: baselineMarked, ms: beforeMs } = await elapsed(async () => {
    const notifications = await Notification.find({
      ...notificationRoleQuery('deposit'),
      createdAt: { $gte: cutoff },
    })
      .select('_id')
      .lean();
    const now = new Date();
    await NotificationRead.bulkWrite(
      notifications.map((notification) => ({
        updateOne: {
          filter: { userId: USER_MARK_ALL_BASELINE, notificationId: notification._id },
          update: { $set: { readAt: now } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    return notifications.length;
  });

  logMetric('marcar todas (ventana 90 días)', {
    notifications: expected,
    before: { rows: baselineMarked, ms: Number(beforeMs.toFixed(2)) },
    after: { rows: marked, ms: Number(afterMs.toFixed(2)) },
  });

  const visible = await listNotificationsForUser({
    userId: USER_MARK_ALL,
    targetRole: 'deposit',
    limit: 100,
  });
  assert.ok(visible.notifications.length > 0);
  assert.ok(
    visible.notifications.every((notification) => notification.read),
    'las notificaciones de la ventana deben quedar leídas',
  );

  // Una notificación fuera de la ventana no debe haberse marcado.
  const oldest = await Notification.findOne({
    ...notificationRoleQuery('deposit'),
    createdAt: { $lt: cutoff },
  })
    .select('_id')
    .lean();
  assert.ok(oldest, 'el seed debe incluir notificaciones fuera de la ventana');
  assert.equal(
    await NotificationRead.countDocuments({ userId: USER_MARK_ALL, notificationId: oldest._id }),
    0,
  );
});

test('la limpieza borra NotificationRead huérfanos sin tocar los válidos', async () => {
  const validCount = await NotificationRead.countDocuments({});
  assert.ok(validCount > 0);

  const orphanIds = Array.from({ length: 2_000 }, () => new mongoose.Types.ObjectId());
  await NotificationRead.insertMany(
    orphanIds.map((notificationId) => ({
      userId: USER_PAGINATION,
      notificationId,
      readAt: new Date(),
      dismissedAt: null,
    })),
    { ordered: false },
  );

  const dryRun = await cleanupOrphanNotificationReads({ batchSize: 500, dryRun: true });
  assert.equal(dryRun.orphans, orphanIds.length);
  assert.equal(dryRun.deleted, 0);
  assert.equal(
    await NotificationRead.countDocuments({ notificationId: { $in: orphanIds } }),
    2_000,
  );

  const progress: NotificationReadCleanupProgress[] = [];
  const { result, ms } = await elapsed(() =>
    cleanupOrphanNotificationReads({
      batchSize: 500,
      onBatch: (batch) => progress.push(batch),
    }),
  );

  logMetric('limpieza de huérfanos', {
    orphans: result.orphans,
    deleted: result.deleted,
    batches: result.batches,
    ms: Number(ms.toFixed(2)),
  });

  assert.ok(result.deleted >= orphanIds.length);
  assert.equal(result.orphans, orphanIds.length);
  assert.ok(progress.length > 1, 'debe procesar por lotes');
  assert.equal(await NotificationRead.countDocuments({ notificationId: { $in: orphanIds } }), 0);
  assert.ok((await NotificationRead.countDocuments({})) > 0, 'no debe borrar estados válidos');
});

test('el índice TTL de Notification declara 180 días en Mongo', async () => {
  const indexes = await Notification.collection.indexes();
  const ttl = indexes.find((index) => index.name === 'notification_retention_ttl');

  assert.ok(ttl, 'debe existir el índice TTL');
  assert.equal(ttl.expireAfterSeconds, NOTIFICATION_RETENTION_SECONDS);
  assert.equal(NOTIFICATION_RETENTION_SECONDS, 180 * 24 * 60 * 60);
});
